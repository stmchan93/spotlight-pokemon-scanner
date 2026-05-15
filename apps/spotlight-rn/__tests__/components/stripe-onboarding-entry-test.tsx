import { screen, waitFor } from '@testing-library/react-native';

import { PaymentsNotEnabledError } from '@spotlight/api-client';

import { StripeOnboardingEntry } from '@/features/payments/screens/stripe-onboarding-entry';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('StripeOnboardingEntry', () => {
  it('renders the "Set up payments" CTA when the user is not onboarded', async () => {
    const repository = createTestSpotlightRepository({
      getStripeConnectStatus: async () => ({
        onboarded: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
        stripeAccountId: null,
      }),
    });

    renderWithProviders(<StripeOnboardingEntry />, { spotlightRepository: repository });

    await waitFor(() => {
      expect(screen.getByTestId('stripe-onboarding-entry-start')).toBeTruthy();
    });
    expect(screen.getByText('Set up payments')).toBeTruthy();
    expect(screen.queryByTestId('stripe-onboarding-entry-active')).toBeNull();
  });

  it('renders the "Payments active" affordances when the user is verified and charges_enabled', async () => {
    const repository = createTestSpotlightRepository({
      getStripeConnectStatus: async () => ({
        onboarded: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
        stripeAccountId: 'acct_123',
      }),
    });

    renderWithProviders(<StripeOnboardingEntry />, { spotlightRepository: repository });

    await waitFor(() => {
      expect(screen.getByTestId('stripe-onboarding-entry-active')).toBeTruthy();
    });
    expect(screen.getByTestId('stripe-onboarding-entry-manage')).toBeTruthy();
    expect(screen.getByText('Manage in Stripe')).toBeTruthy();
  });

  it('renders the PaymentsNotEnabledState when the backend reports 503', async () => {
    const repository = createTestSpotlightRepository({
      getStripeConnectStatus: async () => {
        throw new PaymentsNotEnabledError('Stripe not configured on this backend');
      },
    });

    renderWithProviders(<StripeOnboardingEntry />, { spotlightRepository: repository });

    await waitFor(() => {
      expect(screen.getByTestId('stripe-onboarding-entry-not-enabled')).toBeTruthy();
    });
    expect(screen.getByText('Stripe not configured on this backend')).toBeTruthy();
  });
});
