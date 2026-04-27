import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
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

  it('renders the portfolio shell and recent transactions list', async () => {
    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders>
            <PortfolioScreen onOpenSalesHistory={jest.fn()} />
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.queryByText('Loading Loooty...')).toBeNull();
    expect(await screen.findByText('Track value, inventory, and latest transactions in one place.')).toBeTruthy();
    expect(screen.getAllByText('Portfolio').length).toBeGreaterThan(0);
    expect(screen.getByTestId('portfolio-account-button')).toBeTruthy();
    expect(await screen.findByText('Inventory')).toBeTruthy();
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

  it('switches chart modes and keeps the sell entry available from inventory', async () => {
    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AppProviders>
            <PortfolioScreen onOpenSalesHistory={jest.fn()} />
          </AppProviders>
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    await screen.findByText('Track value, inventory, and latest transactions in one place.');

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
