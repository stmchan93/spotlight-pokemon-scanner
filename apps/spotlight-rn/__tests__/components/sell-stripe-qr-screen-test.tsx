import { screen, waitFor } from '@testing-library/react-native';

import type { PaymentOrder } from '@spotlight/api-client';

import { SellStripeQrScreen } from '@/features/payments/screens/sell-stripe-qr-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

function buildOrder(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    orderId: 'order_test_1',
    status: 'pending',
    amountCents: 4000,
    applicationFeeCents: 160,
    currencyCode: 'USD',
    createdAt: new Date().toISOString(),
    paidAt: null,
    cancelledAt: null,
    cardId: null,
    condition: null,
    description: null,
    sellerUserId: null,
    buyerUserId: null,
    qrUrl: 'https://pay.looty.app/o/order_test_1',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/order_test_1',
    ...overrides,
  };
}

describe('SellStripeQrScreen', () => {
  it('renders the QR tile with the order qr_url while the order is pending', async () => {
    const repository = createTestSpotlightRepository({
      getPaymentOrder: async () => buildOrder({ status: 'pending' }),
    });

    renderWithProviders(
      <SellStripeQrScreen orderId="order_test_1" onClose={jest.fn()} onDone={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('sell-stripe-qr-tile')).toBeTruthy();
    });
    expect(screen.getByText(/Waiting for buyer/)).toBeTruthy();
    expect(screen.getByTestId('sell-stripe-qr-tile-short-url')).toBeTruthy();
  });

  it('flips to a "Paid ✓" confirmation when the order status is paid', async () => {
    const repository = createTestSpotlightRepository({
      getPaymentOrder: async () => buildOrder({ status: 'paid', paidAt: new Date().toISOString() }),
    });

    renderWithProviders(
      <SellStripeQrScreen orderId="order_test_1" onClose={jest.fn()} onDone={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('sell-stripe-qr-paid-label')).toBeTruthy();
    });
    expect(screen.getAllByText('Paid ✓').length).toBeGreaterThan(0);
    expect(screen.getByTestId('sell-stripe-qr-done')).toBeTruthy();
    expect(screen.queryByTestId('sell-stripe-qr-tile')).toBeNull();
  });
});
