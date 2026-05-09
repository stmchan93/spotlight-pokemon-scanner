import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { LatestSalesScreen } from '@/features/sales/screens/latest-sales-screen';

import {
  createTestSpotlightRepository,
  renderWithProviders,
} from '../test-utils';

function buildEmptyDashboard() {
  return {
    state: 'empty' as const,
    data: {
      summary: {
        currentValue: 0,
        changeAmount: 0,
        changePercent: 0,
        asOfLabel: 'Today',
      },
      inventoryCount: 0,
      inventoryItems: [],
      recentSales: [],
      ranges: {
        '1W': { portfolio: [], sales: [] },
        '1M': { portfolio: [], sales: [] },
        '3M': { portfolio: [], sales: [] },
        YTD: { portfolio: [], sales: [] },
        '1Y': { portfolio: [], sales: [] },
        ALL: { portfolio: [], sales: [] },
      },
    },
    errorMessage: null,
  };
}

describe('LatestSalesScreen', () => {
  it('renders the back nav, title, count badge, and the full list of latest sales', async () => {
    renderWithProviders(<LatestSalesScreen onBack={jest.fn()} />);

    expect(await screen.findByText('Latest Sales')).toBeTruthy();
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByTestId('latest-sales-back')).toBeTruthy();
    expect(screen.getByTestId('latest-sales-count')).toBeTruthy();
    // Mock fixture seeds 9 recent sales and the screen renders all of them.
    expect(screen.getByText('(9)')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Oshawott').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('latest-sales-screen-skeleton')).toBeNull();
  });

  it('shows the empty state when there are no sales', async () => {
    const repository = createTestSpotlightRepository({
      loadPortfolioDashboard: async () => buildEmptyDashboard(),
    });

    renderWithProviders(<LatestSalesScreen onBack={jest.fn()} />, {
      spotlightRepository: repository,
    });

    expect(await screen.findByText('No sales yet')).toBeTruthy();
    expect(
      screen.getByText('Completed sales will appear here as soon as you start moving inventory.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('latest-sales-count')).toBeNull();
  });

  it('invokes onBack when the back chrome is pressed', async () => {
    const onBack = jest.fn();
    renderWithProviders(<LatestSalesScreen onBack={onBack} />);

    await screen.findByText('Latest Sales');
    fireEvent.press(screen.getByTestId('latest-sales-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reloads the sales list when pull-to-refresh fires', async () => {
    const loadPortfolioDashboard = jest.fn().mockImplementation(async () => buildEmptyDashboard());
    const repository = createTestSpotlightRepository({
      loadPortfolioDashboard,
    });

    renderWithProviders(<LatestSalesScreen onBack={jest.fn()} />, {
      spotlightRepository: repository,
    });

    await screen.findByText('No sales yet');

    const callsBeforeRefresh = loadPortfolioDashboard.mock.calls.length;
    expect(callsBeforeRefresh).toBeGreaterThanOrEqual(1);

    const scrollView = screen.getByTestId('latest-sales-scroll');
    const refreshControl = scrollView.props.refreshControl;
    expect(refreshControl).toBeTruthy();

    await act(async () => {
      refreshControl.props.onRefresh?.();
    });

    await waitFor(() => {
      expect(loadPortfolioDashboard.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
  });
});
