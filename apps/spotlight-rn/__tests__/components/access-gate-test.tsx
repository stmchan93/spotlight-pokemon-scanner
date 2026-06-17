import { Text } from 'react-native';
import { screen, waitFor } from '@testing-library/react-native';

import { AccessGate } from '@/features/auth/components/access-gate';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// BetweenShowsScreen pulls auth context for the prefill email + sign out; stub
// it so the gate test focuses purely on the allow/block decision.
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: { email: 'collector@example.com' },
    isBusy: false,
    signOut: jest.fn(),
  }),
}));

function AppContent() {
  return <Text testID="gated-app-content">App content</Text>;
}

describe('AccessGate', () => {
  it('renders the app when access status is allowed', async () => {
    const getAccessStatus = jest.fn().mockResolvedValue({
      accessOpen: true,
      allowed: true,
      isAdmin: false,
      showMode: { active: true, until: null, remainingSeconds: 0 },
    });
    const spotlightRepository = createTestSpotlightRepository({ getAccessStatus });

    renderWithProviders(
      <AccessGate>
        <AppContent />
      </AccessGate>,
      { spotlightRepository },
    );

    expect(await screen.findByTestId('gated-app-content')).toBeTruthy();
    expect(screen.queryByTestId('between-shows-screen')).toBeNull();
  });

  it('renders the between-shows screen when access is blocked', async () => {
    const getAccessStatus = jest.fn().mockResolvedValue({
      accessOpen: false,
      allowed: false,
      isAdmin: false,
      showMode: { active: false, until: null, remainingSeconds: 0 },
    });
    const spotlightRepository = createTestSpotlightRepository({ getAccessStatus });

    renderWithProviders(
      <AccessGate>
        <AppContent />
      </AccessGate>,
      { spotlightRepository },
    );

    expect(await screen.findByTestId('between-shows-screen')).toBeTruthy();
    expect(screen.queryByTestId('gated-app-content')).toBeNull();
  });

  it('fails open and renders the app when the status call rejects', async () => {
    const getAccessStatus = jest.fn().mockRejectedValue(new Error('network blip'));
    const spotlightRepository = createTestSpotlightRepository({ getAccessStatus });

    renderWithProviders(
      <AccessGate>
        <AppContent />
      </AccessGate>,
      { spotlightRepository },
    );

    await waitFor(() => {
      expect(getAccessStatus).toHaveBeenCalled();
    });
    expect(await screen.findByTestId('gated-app-content')).toBeTruthy();
  });
});
