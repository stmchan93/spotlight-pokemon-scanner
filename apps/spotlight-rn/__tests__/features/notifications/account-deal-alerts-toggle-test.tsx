import { Alert } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { NotificationPrefs } from '@spotlight/api-client';

import { AccountScreen } from '@/features/auth/screens/account-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: { email: 'tester@example.com', id: 'owner-1', name: 'Tester' },
    isBusy: false,
    isGuest: false,
    signOut: jest.fn(async () => {}),
  }),
}));

// The OS side is already granted here; the permission dance has its own suite.
jest.mock('@/features/notifications', () => ({
  revokePushToken: jest.fn(async () => true),
  usePushPermissionPrompt: () => ({
    enablePushNotifications: jest.fn(async () => true),
    isBusy: false,
    isEnabled: true,
    permission: 'granted',
    refresh: jest.fn(async () => {}),
  }),
}));

function renderAccount(overrides: Parameters<typeof createTestSpotlightRepository>[0] = {}) {
  const repository = createTestSpotlightRepository(overrides);
  renderWithProviders(<AccountScreen />, { spotlightRepository: repository });
  return repository;
}

describe('Account screen — deal alerts toggle', () => {
  it('reflects the stored preference', async () => {
    renderAccount({
      getNotificationPrefs: jest.fn(
        async (): Promise<NotificationPrefs> => ({
          dealAlertsEnabled: true,
          targetHitsEnabled: true,
        }),
      ),
    });

    await waitFor(() => {
      expect(screen.getByTestId('account-deal-alerts-toggle').props.value).toBe(true);
    });
  });

  it('writes the new value optimistically', async () => {
    const setNotificationPrefs = jest.fn(async () => ({
      prefs: { dealAlertsEnabled: false, targetHitsEnabled: true },
      status: 'ok' as const,
    }));
    renderAccount({ setNotificationPrefs });

    const toggle = await screen.findByTestId('account-deal-alerts-toggle');
    await waitFor(() => {
      expect(toggle.props.value).toBe(true);
    });

    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => {
      expect(setNotificationPrefs).toHaveBeenCalledWith({ dealAlertsEnabled: false });
    });
    await waitFor(() => {
      expect(screen.getByTestId('account-deal-alerts-toggle').props.value).toBe(false);
    });
  });

  it('reverts and explains itself when the write fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderAccount({
      setNotificationPrefs: jest.fn(async () => ({ prefs: null, status: 'failed' as const })),
    });

    const toggle = await screen.findByTestId('account-deal-alerts-toggle');
    await waitFor(() => {
      expect(toggle.props.value).toBe(true);
    });

    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Could not update deal alerts',
        expect.any(String),
      );
    });
    // Back where it was — an optimistic flip that the server refused.
    expect(screen.getByTestId('account-deal-alerts-toggle').props.value).toBe(true);
    alertSpy.mockRestore();
  });
});
