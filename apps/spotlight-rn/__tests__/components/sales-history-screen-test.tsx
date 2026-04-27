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
});
