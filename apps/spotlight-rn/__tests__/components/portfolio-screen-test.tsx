import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as mockApiClient from '../mock-api-client';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { AppProviders } from '@/providers/app-providers';

jest.mock('@spotlight/api-client', () => mockApiClient);

describe('PortfolioScreen', () => {
  const safeAreaMetrics = {
    frame: { height: 852, width: 393, x: 0, y: 0 },
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
  };

  function renderPortfolioScreen({
    repository,
    showPortfolio = true,
  }: {
    repository?: mockApiClient.SpotlightRepository;
    showPortfolio?: boolean;
  } = {}) {
    return render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders spotlightRepository={repository}>
            {showPortfolio ? (
              <PortfolioScreen onOpenSalesHistory={jest.fn()} />
            ) : (
              <Text testID="portfolio-placeholder">Portfolio hidden</Text>
            )}
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );
  }

  it('renders the portfolio shell and recent transactions list', async () => {
    renderPortfolioScreen();

    expect(screen.queryByText('Loading Loooty...')).toBeNull();
    expect(await screen.findByText('Track value, favorites, and your latest transactions in one place.')).toBeTruthy();
    expect(screen.getAllByText('Collection').length).toBeGreaterThan(0);
    expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    expect(screen.getByText('(6)')).toBeTruthy();
    expect(screen.getAllByText('View All').length).toBeGreaterThan(0);
    expect(screen.getByText('Bulk Sell')).toBeTruthy();
    expect(await screen.findByText('Latest Sales')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

    const addCardStyle = StyleSheet.flatten(screen.getByText('Add Card').props.style);
    const bulkSellStyle = StyleSheet.flatten(screen.getByText('Bulk Sell').props.style);
    const viewAllStyle = StyleSheet.flatten(screen.getAllByText('View All')[0].props.style);
    const salesToggleStyle = StyleSheet.flatten(screen.getByText('Sales').props.style);
    const rangeAllStyle = StyleSheet.flatten(screen.getByText('All').props.style);

    [addCardStyle, bulkSellStyle, viewAllStyle, salesToggleStyle, rangeAllStyle].forEach((style) => {
      expect(style).toMatchObject({
        fontFamily: 'SpotlightBodySemiBold',
        fontSize: 15,
        lineHeight: 20,
      });
    });
  });

  it('renders cached inventory with chart and sales skeletons before the first dashboard load resolves', async () => {
    const repository = new mockApiClient.MockSpotlightRepository();
    const sourceRepository = new mockApiClient.MockSpotlightRepository();
    let resolveDashboard: (
      value: Awaited<ReturnType<mockApiClient.MockSpotlightRepository['loadPortfolioDashboard']>>
    ) => void = () => {};

    jest.spyOn(repository, 'loadPortfolioDashboard').mockImplementation(() => {
      return new Promise((resolve) => {
        resolveDashboard = resolve;
      });
    });

    renderPortfolioScreen({ repository });

    expect(screen.queryByText('Loading your portfolio...')).toBeNull();
    expect(await screen.findByTestId('portfolio-chart-skeleton')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-summary-value')).toBeTruthy();
    expect(screen.queryByTestId('portfolio-chart-summary-value-skeleton')).toBeNull();
    expect(await screen.findByText('(6)')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
    expect(screen.getByTestId('latest-sales-skeleton')).toBeTruthy();

    const dashboardResult = await sourceRepository.loadPortfolioDashboard();
    await act(async () => {
      resolveDashboard(dashboardResult);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('portfolio-chart-skeleton')).toBeNull();
    });
    expect(screen.getByTestId('portfolio-chart-summary-value')).toBeTruthy();
  });

  it('uses the provider cache when the portfolio screen remounts', async () => {
    const repository = new mockApiClient.MockSpotlightRepository();

    const { rerender } = renderPortfolioScreen({ repository });

    expect(await screen.findByText('(6)')).toBeTruthy();

    await act(async () => {
      rerender(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <SpotlightThemeProvider>
            <AppProviders spotlightRepository={repository}>
              <Text testID="portfolio-placeholder">Portfolio hidden</Text>
            </AppProviders>
          </SpotlightThemeProvider>
        </SafeAreaProvider>,
      );
    });

    expect(screen.getByTestId('portfolio-placeholder')).toBeTruthy();

    await act(async () => {
      rerender(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <SpotlightThemeProvider>
            <AppProviders spotlightRepository={repository}>
              <PortfolioScreen onOpenSalesHistory={jest.fn()} />
            </AppProviders>
          </SpotlightThemeProvider>
        </SafeAreaProvider>,
      );
    });

    expect(screen.queryByText('Loading your portfolio...')).toBeNull();
    expect(screen.getByText('(6)')).toBeTruthy();
  });

  it('switches chart modes and keeps the sell entry available from inventory', async () => {
    renderPortfolioScreen();

    await screen.findByText('Track value, favorites, and your latest transactions in one place.');

    fireEvent.press(screen.getByText('Sales'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-chart-sales')).toBeTruthy();
    });

    expect(screen.getByTestId('portfolio-sell-entry')).toBeTruthy();
    expect(screen.queryByTestId('inventory-density-control')).toBeNull();
  });

  it('opens transactions history from the latest sales header action', async () => {
    const onOpenSalesHistory = jest.fn();

    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders>
            <PortfolioScreen onOpenSalesHistory={onOpenSalesHistory} />
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    fireEvent.press(await screen.findByTestId('latest-sales-see-more'));

    expect(onOpenSalesHistory).toHaveBeenCalledTimes(1);
  });

  it('edits a latest sold transaction price with the lightweight modal and updates sales totals locally', async () => {
    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders>
            <PortfolioScreen onOpenSalesHistory={jest.fn()} />
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    fireEvent.press(await screen.findByTestId('recent-sale-card-sale-1'));

    expect(screen.getByText('Edit Sale Price')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('edit-sale-price-input'), '9.5');
    fireEvent.press(screen.getByTestId('edit-sale-confirm'));

    await waitFor(() => {
      expect(screen.queryByText('Edit Sale Price')).toBeNull();
    });

    expect(screen.getByText('$9.50')).toBeTruthy();

    fireEvent.press(screen.getByText('Sales'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$106.60');
    });

    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('6 sales');
  });
});
