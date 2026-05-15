import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PaymentsNotEnabledError } from '@spotlight/api-client';

import { RefundSheet } from '@/features/payments/screens/refund-sheet';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('RefundSheet', () => {
  it('issues a full refund by default and forwards the resolved refund record', async () => {
    const refundPaymentOrder = jest.fn(async () => ({
      orderId: 'order_abc',
      status: 'refunded' as const,
      refundedAmountCents: 4000,
      amountCents: 4000,
      currencyCode: 'USD',
      paidAt: '2026-05-15T01:00:00.000Z',
      refundedAt: '2026-05-15T02:00:00.000Z',
    }));
    const repository = createTestSpotlightRepository({ refundPaymentOrder });
    const onRefundCompleted = jest.fn();

    renderWithProviders(
      <RefundSheet
        cardName="Pikachu"
        currencyCode="USD"
        onClose={jest.fn()}
        onRefundCompleted={onRefundCompleted}
        orderId="order_abc"
        soldAmount={40}
      />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('refund-sheet-submit')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('refund-sheet-submit'));

    await waitFor(() => {
      expect(refundPaymentOrder).toHaveBeenCalledTimes(1);
    });
    expect(refundPaymentOrder).toHaveBeenCalledWith(
      'order_abc',
      expect.objectContaining({ amountCents: undefined }),
    );
    expect(onRefundCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order_abc',
        refundedAmountCents: 4000,
      }),
    );
  });

  it('refuses partial amounts that exceed the original sale total', async () => {
    const refundPaymentOrder = jest.fn();
    const repository = createTestSpotlightRepository({ refundPaymentOrder });

    renderWithProviders(
      <RefundSheet
        cardName="Pikachu"
        currencyCode="USD"
        onClose={jest.fn()}
        orderId="order_abc"
        soldAmount={40}
      />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('refund-sheet-full-toggle')).toBeTruthy();
    });

    fireEvent(screen.getByTestId('refund-sheet-full-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(screen.getByTestId('refund-sheet-partial-input')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('refund-sheet-partial-input'), '999');
    fireEvent.press(screen.getByTestId('refund-sheet-submit'));

    expect(refundPaymentOrder).not.toHaveBeenCalled();
    // Submit is disabled while the partial amount is invalid; the disabled
    // accessibility state is set on the underlying button surface.
    expect(screen.getByTestId('refund-sheet-submit').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  it('sends a partial refund when the user enters a valid amount', async () => {
    const refundPaymentOrder = jest.fn(async () => ({
      orderId: 'order_abc',
      status: 'refunded' as const,
      refundedAmountCents: 1500,
      amountCents: 4000,
      currencyCode: 'USD',
      paidAt: '2026-05-15T01:00:00.000Z',
      refundedAt: '2026-05-15T02:00:00.000Z',
    }));
    const repository = createTestSpotlightRepository({ refundPaymentOrder });

    renderWithProviders(
      <RefundSheet
        cardName="Pikachu"
        currencyCode="USD"
        onClose={jest.fn()}
        orderId="order_abc"
        soldAmount={40}
      />,
      { spotlightRepository: repository },
    );

    fireEvent(screen.getByTestId('refund-sheet-full-toggle'), 'valueChange', false);
    fireEvent.changeText(screen.getByTestId('refund-sheet-partial-input'), '15');
    fireEvent.press(screen.getByTestId('refund-sheet-submit'));

    await waitFor(() => {
      expect(refundPaymentOrder).toHaveBeenCalledWith(
        'order_abc',
        expect.objectContaining({ amountCents: 1500 }),
      );
    });
  });

  it('renders the payments-not-enabled state when the repository raises a PaymentsNotEnabledError', async () => {
    const refundPaymentOrder = jest.fn(async () => {
      throw new PaymentsNotEnabledError('Stripe is not configured for this environment.');
    });
    const repository = createTestSpotlightRepository({ refundPaymentOrder });

    renderWithProviders(
      <RefundSheet
        cardName="Pikachu"
        currencyCode="USD"
        onClose={jest.fn()}
        orderId="order_abc"
        soldAmount={40}
      />,
      { spotlightRepository: repository },
    );

    fireEvent.press(screen.getByTestId('refund-sheet-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('refund-sheet-not-enabled')).toBeTruthy();
    });
  });

  it('renders a non-actionable refunded state when the order was already refunded', async () => {
    const refundPaymentOrder = jest.fn();
    const repository = createTestSpotlightRepository({ refundPaymentOrder });

    renderWithProviders(
      <RefundSheet
        alreadyRefunded
        cardName="Pikachu"
        currencyCode="USD"
        onClose={jest.fn()}
        orderId="order_abc"
        soldAmount={40}
      />,
      { spotlightRepository: repository },
    );

    expect(screen.getByTestId('refund-sheet-already-refunded')).toBeTruthy();
    expect(screen.queryByTestId('refund-sheet-submit')).toBeNull();
    expect(refundPaymentOrder).not.toHaveBeenCalled();
  });
});
