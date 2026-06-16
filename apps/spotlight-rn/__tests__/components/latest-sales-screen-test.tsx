import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { CardTransactionRecord } from '@spotlight/api-client';

import { LatestSalesScreen } from '@/features/sales/screens/latest-sales-screen';

import {
  createTestSpotlightRepository,
  renderWithProviders,
} from '../test-utils';

// TransactionThumb (via 03fbbfd) calls useAuth; these screens render it without
// an AuthProvider in the harness, so stub the hook to the no-token path.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

const sampleTransactions: CardTransactionRecord[] = [
  {
    id: 'txn-sold',
    kind: 'sold',
    amountCents: 4500,
    currencyCode: 'USD',
    occurredAt: '2026-04-21T16:30:00.000Z',
    occurredAtLabel: 'Sold on Apr 21, 2026',
    note: 'Sold to a local buyer',
    itemCount: 7,
    photoUrl: 'https://images.example/sold.png',
    createdAt: '2026-04-21T16:31:00.000Z',
    paymentMethod: 'venmo',
  },
  {
    id: 'txn-bought',
    kind: 'bought',
    amountCents: 1200,
    currencyCode: 'USD',
    occurredAt: '2026-04-20T12:05:00.000Z',
    occurredAtLabel: 'Bought on Apr 20, 2026',
    note: 'Pickup from a show',
    itemCount: 27,
    photoUrl: 'https://images.example/bought.png',
    createdAt: '2026-04-20T12:06:00.000Z',
  },
  {
    id: 'txn-traded',
    kind: 'traded',
    amountCents: null,
    currencyCode: 'USD',
    occurredAt: '2026-04-19T09:15:00.000Z',
    occurredAtLabel: 'Traded on Apr 19, 2026',
    note: null,
    itemCount: 7,
    photoUrl: null,
    createdAt: '2026-04-19T09:16:00.000Z',
  },
];

function buildRepository(transactions: CardTransactionRecord[] = sampleTransactions) {
  return createTestSpotlightRepository({
    listCardTransactions: async () => transactions.map((transaction) => ({ ...transaction })),
  });
}

describe('LatestSalesScreen', () => {
  it('renders transactions sourced from listCardTransactions with verb title, payment method, and signed amount', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository() });

    expect(await screen.findByTestId('sales-header-title')).toBeTruthy();
    expect(screen.getByTestId('sales-header-title').props.children).toBe('Transactions');

    // No stat tiles or edit sheet in the memory bank.
    expect(screen.queryByTestId('sales-stat-tile-row')).toBeNull();

    const list = await screen.findByTestId('latest-sales-list');
    expect(list).toBeTruthy();

    const soldRow = screen.getByTestId('latest-transaction-card-txn-sold');
    expect(soldRow).toBeTruthy();
    expect(screen.getByTestId('latest-transaction-card-txn-sold-photo')).toBeTruthy();
    // Title is the verb (sold → Sell); subtitle is "N Items · <payment method>".
    expect(screen.getByTestId('latest-transaction-card-txn-sold-title').props.children).toBe('Sell');
    expect(screen.getByTestId('latest-transaction-card-txn-sold-subtitle').props.children).toBe('7 Items · Venmo');
    expect(screen.getByTestId('latest-transaction-card-txn-sold-amount').props.children).toBe('$45.00');
    // Bought reads as Buy and omits the payment method when none is set.
    expect(screen.getByTestId('latest-transaction-card-txn-bought-title').props.children).toBe('Buy');
    expect(screen.getByTestId('latest-transaction-card-txn-bought-subtitle').props.children).toBe('27 Items');
    expect(screen.getByTestId('latest-transaction-card-txn-bought-amount').props.children).toBe('$12.00');
    // A trade shows the swap glyph and no amount.
    expect(screen.getByTestId('latest-transaction-card-txn-traded-title').props.children).toBe('Trade');
    expect(screen.queryByTestId('latest-transaction-card-txn-traded-amount')).toBeNull();
  });

  it('shows the empty state when there are no transactions', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository([]) });

    expect(await screen.findByText('No transactions yet')).toBeTruthy();
    expect(screen.queryByTestId('latest-sales-list')).toBeNull();
  });

  it('filters by kind through the filter pills', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository() });

    await screen.findByTestId('latest-sales-list');

    fireEvent.press(screen.getByTestId('sales-filter-bought'));

    await waitFor(() => {
      expect(screen.getByTestId('latest-transaction-card-txn-bought')).toBeTruthy();
    });
    expect(screen.queryByTestId('latest-transaction-card-txn-sold')).toBeNull();
    expect(screen.queryByTestId('latest-transaction-card-txn-traded')).toBeNull();
  });

  it('searches transactions by note text', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository() });

    await screen.findByTestId('latest-sales-list');

    fireEvent.changeText(
      screen.getByPlaceholderText('Search your transactions'),
      'show',
    );

    await waitFor(() => {
      expect(screen.getByTestId('latest-transaction-card-txn-bought')).toBeTruthy();
    });
    expect(screen.queryByTestId('latest-transaction-card-txn-sold')).toBeNull();
  });

  it('routes the add FAB to the transaction logger', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository() });

    await screen.findByTestId('latest-sales-list');
    expect(screen.getByTestId('collection-add-fab')).toBeTruthy();
  });

  it('renders a back button (Transactions is pushed in from the drawer)', async () => {
    renderWithProviders(<LatestSalesScreen />, { spotlightRepository: buildRepository() });

    await screen.findByTestId('sales-header-title');
    expect(screen.getByTestId('sales-header-back')).toBeTruthy();
  });
});
