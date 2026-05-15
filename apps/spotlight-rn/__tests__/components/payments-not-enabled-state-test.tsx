import { fireEvent, screen } from '@testing-library/react-native';

import { PaymentsNotEnabledState } from '@/features/payments/components/payments-not-enabled-state';

import { renderWithProviders } from '../test-utils';

describe('PaymentsNotEnabledState', () => {
  it('renders the default disabled-state copy and no retry button when no handler is provided', () => {
    renderWithProviders(<PaymentsNotEnabledState />);

    expect(screen.getByTestId('payments-not-enabled-state')).toBeTruthy();
    expect(screen.getByText('Payments aren’t enabled')).toBeTruthy();
    expect(screen.queryByTestId('payments-not-enabled-state-retry')).toBeNull();
  });

  it('renders the supplied message and calls onRetry when the retry button is pressed', () => {
    const onRetry = jest.fn();
    renderWithProviders(
      <PaymentsNotEnabledState
        message="Stripe not configured on this backend"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Stripe not configured on this backend')).toBeTruthy();

    fireEvent.press(screen.getByTestId('payments-not-enabled-state-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
