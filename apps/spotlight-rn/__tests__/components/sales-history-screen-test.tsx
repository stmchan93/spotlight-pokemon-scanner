import { fireEvent, screen } from '@testing-library/react-native';

import { SalesHistoryScreen } from '@/features/portfolio/screens/sales-history-screen';

import { renderWithProviders } from '../test-utils';

describe('SalesHistoryScreen', () => {
  it('uses the inventory-style all transactions shell without the old subtitle', async () => {
    renderWithProviders(<SalesHistoryScreen onBack={jest.fn()} />);

    expect(await screen.findByText('All Transactions')).toBeTruthy();
    expect(screen.getByText('Transactions')).toBeTruthy();
    expect(screen.getByText('9 shown')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search transactions')).toBeTruthy();
    expect(screen.getByTestId('sales-sort-recent')).toBeTruthy();
    expect(screen.getByTestId('sales-filter-all')).toBeTruthy();
    expect(screen.queryByText('All Sales')).toBeNull();
    expect(screen.queryByText('Full list of recent sold cards from the portfolio shell.')).toBeNull();
  });

  it('filters and searches through transactions', async () => {
    renderWithProviders(<SalesHistoryScreen onBack={jest.fn()} />);

    expect(await screen.findByText('All Transactions')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sales-filter-traded'));
    expect(screen.getByText('3 shown')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sales-filter-all'));
    fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'oshawott');

    expect(screen.getByText('1 shown')).toBeTruthy();
    expect(screen.getByText('Oshawott')).toBeTruthy();
  });

  it('opens a sold transaction for inspection/editing while traded rows stay read only', async () => {
    renderWithProviders(<SalesHistoryScreen onBack={jest.fn()} />);

    expect(await screen.findByText('All Transactions')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sales-filter-sold'));

    expect(screen.getByText('6 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.queryByText('Hoopa V')).toBeNull();

    fireEvent.press(screen.getByTestId('sales-card-sale-1'));

    expect(screen.getByText('Edit Sale Price')).toBeTruthy();
    expect(screen.getByText('Scorbunny • Sold on Apr 21, 2026')).toBeTruthy();
    expect(screen.getByDisplayValue('1')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('edit-sale-price-input'), '9.5');
    fireEvent.press(screen.getByTestId('edit-sale-confirm'));

    expect(screen.queryByText('Edit Sale Price')).toBeNull();
    expect(screen.getByText('$9.50')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sales-filter-traded'));

    expect(screen.getByText('3 shown')).toBeTruthy();
    expect(screen.getByText('Hoopa V')).toBeTruthy();
    expect(screen.getByText('Traded on Apr 18, 2026')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sales-card-sale-8'));

    expect(screen.queryByText('Edit Sale Price')).toBeNull();
  });
});
