import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as mockApiClient from '../mock-api-client';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { __resetPortfolioSummaryVisibilityForTests } from '@/features/portfolio/use-portfolio-summary-visibility';
import { AppProviders } from '@/providers/app-providers';

jest.mock('@spotlight/api-client', () => mockApiClient);

describe('PortfolioScreen', () => {
  const safeAreaMetrics = {
    frame: { height: 852, width: 393, x: 0, y: 0 },
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
  };

  // The portfolio dashboard refresh effect is gated on the tabs context's
  // activePage being 'portfolio' so the 13-call fan-out doesn't fire while
  // the user is on the scanner tab. The default context value is 'scanner'
  // for isolated renders; tests targeting the portfolio screen must override
  // it so the loading effects run.
  const portfolioTabsContext = {
    activePage: 'portfolio' as const,
    chartScrubLockRef: { current: false },
  };

  beforeEach(() => {
    __resetPortfolioSummaryVisibilityForTests();
  });

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
            <TabsPageContext.Provider value={portfolioTabsContext}>
              {showPortfolio ? (
                <PortfolioScreen />
              ) : (
                <Text testID="portfolio-placeholder">Portfolio hidden</Text>
              )}
            </TabsPageContext.Provider>
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );
  }

  it('renders the portfolio shell, summary, tabs, and inventory tiles', async () => {
    renderPortfolioScreen();

    expect(screen.queryByText('Loading Loooty...')).toBeNull();
    expect(await screen.findByTestId('portfolio-header-title')).toBeTruthy();
    expect(screen.getByTestId('portfolio-header-title').props.children).toBe('Collection');
    expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('portfolio-scroll-view').props.contentContainerStyle)).toMatchObject({
      paddingBottom: 114,
    });

    // Summary block at the screen level.
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-mode-trigger')).toBeTruthy();

    // Page-tabs primitive between chart and content.
    expect(screen.getByTestId('portfolio-collection-tabs')).toBeTruthy();
    expect(screen.getByTestId('portfolio-collection-tabs-tab-portfolio')).toBeTruthy();
    expect(screen.getByTestId('portfolio-collection-tabs-tab-recent-sales')).toBeTruthy();
    expect(screen.getByTestId('portfolio-collection-tabs-tab-favorites')).toBeTruthy();

    // Default tab is Portfolio: shows Collection section header + grid.
    expect(screen.getByTestId('portfolio-inventory-view-all')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

    // Range pill 'All' uses overline typography (Plus Jakarta Sans Medium 500).
    const rangeAllStyle = StyleSheet.flatten(screen.getByText('All').props.style);
    expect(rangeAllStyle).toMatchObject({
      fontFamily: 'SpotlightBodyMedium',
    });
  });

  it('masks the summary value and delta when the visibility toggle is pressed', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-summary-value');
    const summaryDelta = screen.getByTestId('portfolio-summary-delta');
    const toggle = screen.getByTestId('portfolio-summary-visibility-toggle');

    expect(String(summaryDelta.props.children)).not.toBe('*****');
    expect(screen.queryAllByText('*****').length).toBe(0);

    await act(async () => {
      fireEvent.press(toggle);
    });

    await waitFor(() => {
      expect(String(summaryDelta.props.children)).toBe('*****');
      expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.press(toggle);
    });

    await waitFor(() => {
      expect(String(summaryDelta.props.children)).not.toBe('*****');
      expect(screen.queryAllByText('*****').length).toBe(0);
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
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

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
              <TabsPageContext.Provider value={portfolioTabsContext}>
                <Text testID="portfolio-placeholder">Portfolio hidden</Text>
              </TabsPageContext.Provider>
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
              <TabsPageContext.Provider value={portfolioTabsContext}>
                <PortfolioScreen />
              </TabsPageContext.Provider>
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
    expect(screen.getByTestId('portfolio-chart-portfolio')).toBeTruthy();

    fireEvent.press(screen.getByTestId('portfolio-chart-mode-trigger'));
    fireEvent.press(await screen.findByTestId('portfolio-chart-mode-option-sales'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-chart-sales')).toBeTruthy();
    });
  });

  it('switches to the Recent Sales tab to see the sales list', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-header-title');

    // Recent Sales not visible while Portfolio tab is active.
    expect(screen.queryByTestId('recent-sale-card-sale-1')).toBeNull();

    fireEvent.press(screen.getByTestId('portfolio-collection-tabs-tab-recent-sales'));

    expect(await screen.findByTestId('recent-sale-card-sale-1')).toBeTruthy();
    expect(screen.getByText('Latest Sales')).toBeTruthy();
  });

  it('switches to Favorites tab and shows the empty state when no favorites', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-header-title');

    fireEvent.press(screen.getByTestId('portfolio-collection-tabs-tab-favorites'));

    // Mock data has no favorited entries → empty state shown.
    await waitFor(() => {
      expect(screen.getByText('No favorites yet')).toBeTruthy();
    });
  });

  it('edits a latest sold transaction price with the lightweight modal', async () => {
    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders>
            <TabsPageContext.Provider value={portfolioTabsContext}>
              <PortfolioScreen />
            </TabsPageContext.Provider>
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    await screen.findByTestId('portfolio-header-title');

    // Switch to Recent Sales tab to see the sales cards.
    fireEvent.press(screen.getByTestId('portfolio-collection-tabs-tab-recent-sales'));

    fireEvent.press(await screen.findByTestId('recent-sale-card-sale-1'));

    expect(screen.getByText('Edit Sale Price')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('edit-sale-price-input'), '9.5');
    fireEvent.press(screen.getByTestId('edit-sale-confirm'));

    await waitFor(() => {
      expect(screen.queryByText('Edit Sale Price')).toBeNull();
    });

    expect(screen.getByText('$9.50')).toBeTruthy();
  });
});
