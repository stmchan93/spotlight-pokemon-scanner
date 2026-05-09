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

  it('renders the portfolio shell, summary, and inventory tiles', async () => {
    renderPortfolioScreen();

    expect(screen.queryByText('Loading Loooty...')).toBeNull();
    expect(await screen.findByTestId('portfolio-header-title')).toBeTruthy();
    expect(screen.getByTestId('portfolio-header-title').props.children).toBe('Collection');
    expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('portfolio-scroll-view').props.contentContainerStyle)).toMatchObject({
      paddingBottom: 114,
    });

    // Summary value + delta block at the screen level (chart card no longer
    // owns the summary text).
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-mode-trigger')).toBeTruthy();

    // Inventory + Latest Sales section actions both expose "View All".
    expect(screen.getByTestId('portfolio-inventory-view-all')).toBeTruthy();
    expect(await screen.findByTestId('latest-sales-see-more')).toBeTruthy();
    expect(await screen.findByText('Latest Sales')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

    // Range pills use the new labels.
    const rangeAllStyle = StyleSheet.flatten(screen.getByText('All').props.style);
    const viewAllStyle = StyleSheet.flatten(screen.getAllByText('View All')[0].props.style);

    [viewAllStyle, rangeAllStyle].forEach((style) => {
      expect(style).toMatchObject({
        fontFamily: 'SpotlightBodySemiBold',
        fontSize: 15,
        lineHeight: 20,
      });
    });
  });

  it('renders cached inventory and the screen-level summary while the dashboard load is pending', async () => {
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
    // Screen-level summary value is always present (chart no longer owns it).
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
    expect(screen.getByTestId('latest-sales-skeleton')).toBeTruthy();

    const dashboardResult = await sourceRepository.loadPortfolioDashboard();
    await act(async () => {
      resolveDashboard(dashboardResult);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('portfolio-chart-skeleton')).toBeNull();
    });
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
  });

  it('uses the provider cache when the portfolio screen remounts', async () => {
    const repository = new mockApiClient.MockSpotlightRepository();

    const { rerender } = renderPortfolioScreen({ repository });

    expect(await screen.findAllByText('Scorbunny')).not.toHaveLength(0);

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
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
  });

  it('switches chart modes via the popover and renders the sales chart', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-header-title');
    // Default view shows the portfolio chart.
    expect(screen.getByTestId('portfolio-chart-portfolio')).toBeTruthy();

    fireEvent.press(screen.getByTestId('portfolio-chart-mode-trigger'));
    fireEvent.press(await screen.findByTestId('portfolio-chart-mode-option-sales'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-chart-sales')).toBeTruthy();
    });

    // The Bulk Sell entry point moved to the Inventory Browser, so the
    // Portfolio screen no longer renders an inline sell entry control.
    expect(screen.queryByTestId('portfolio-sell-entry')).toBeNull();
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

  it('edits a latest sold transaction price with the lightweight modal', async () => {
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

    // The Latest Sales card reflects the locally-edited price.
    expect(screen.getByText('$9.50')).toBeTruthy();
  });
});
