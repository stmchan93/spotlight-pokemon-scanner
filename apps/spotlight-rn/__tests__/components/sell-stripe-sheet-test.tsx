import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { mockInventoryEntries } from '@spotlight/api-client';

import { SellStripeSheet } from '@/features/payments/screens/sell-stripe-sheet';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('SellStripeSheet', () => {
  it('disables the submit button until a valid price is entered', async () => {
    const createPaymentOrder = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createPaymentOrder,
    });

    renderWithProviders(
      <SellStripeSheet entryId="entry-1" onClose={jest.fn()} onOrderCreated={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('sell-stripe-submit')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('sell-stripe-submit'));
    expect(createPaymentOrder).not.toHaveBeenCalled();
  });

  it('rejects 0 and negative prices', async () => {
    const createPaymentOrder = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createPaymentOrder,
    });

    renderWithProviders(
      <SellStripeSheet entryId="entry-1" onClose={jest.fn()} onOrderCreated={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('sell-stripe-price-input')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('sell-stripe-price-input'), '0');
    fireEvent.press(screen.getByTestId('sell-stripe-submit'));
    expect(createPaymentOrder).not.toHaveBeenCalled();
  });

  it('calls createPaymentOrder with the entered amount in cents and forwards the new orderId', async () => {
    const createPaymentOrder = jest.fn(async () => ({
      orderId: 'order_test_1',
      qrUrl: 'https://pay.looty.app/o/order_test_1',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/order_test_1',
      status: 'pending' as const,
    }));
    const onOrderCreated = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createPaymentOrder,
    });

    renderWithProviders(
      <SellStripeSheet
        entryId="entry-1"
        onClose={jest.fn()}
        onOrderCreated={onOrderCreated}
      />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('sell-stripe-price-input')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('sell-stripe-price-input'), '40');
    fireEvent.press(screen.getByTestId('sell-stripe-submit'));

    await waitFor(() => {
      expect(createPaymentOrder).toHaveBeenCalledTimes(1);
    });
    expect(createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        deckEntryId: 'entry-1',
        amountCents: 4000,
      }),
    );
    expect(onOrderCreated).toHaveBeenCalledWith('order_test_1');
  });
});
