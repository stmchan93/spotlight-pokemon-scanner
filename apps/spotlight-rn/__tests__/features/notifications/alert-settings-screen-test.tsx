import { Alert } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { AlertPreferences } from '@spotlight/api-client';

import { AccountScreen } from '@/features/auth/screens/account-screen';
import { AlertSettingsScreen } from '@/features/notifications/screens/alert-settings-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
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

const mockPermission = {
  enablePushNotifications: jest.fn(async () => true),
  isBusy: false,
  isEnabled: true,
  permission: 'granted',
  refresh: jest.fn(async () => {}),
};
jest.mock('@/features/notifications/use-push-registration', () => ({
  usePushPermissionPrompt: () => mockPermission,
}));
jest.mock('@/features/notifications', () => ({
  revokePushToken: jest.fn(async () => true),
}));

const ALL_ON: AlertPreferences = {
  dealAlertsEnabled: true,
  priceMovesEnabled: true,
  weeklySummaryEnabled: true,
};

function renderAlerts(overrides: Parameters<typeof createTestSpotlightRepository>[0] = {}) {
  const repository = createTestSpotlightRepository(overrides);
  renderWithProviders(<AlertSettingsScreen />, { spotlightRepository: repository });
  return repository;
}

beforeEach(() => {
  mockPush.mockReset();
  mockPermission.isEnabled = true;
  mockPermission.enablePushNotifications.mockReset().mockResolvedValue(true);
});

describe('Alert settings screen', () => {
  it('shows exactly the three switches with their one-line descriptions', async () => {
    renderAlerts({
      fetchAlertPreferences: jest.fn(async () => ({ ...ALL_ON, weeklySummaryEnabled: false })),
    });

    await waitFor(() => {
      expect(screen.getByTestId('alert-settings-weekly-summary').props.value).toBe(false);
    });
    expect(screen.getByTestId('alert-settings-price-moves').props.value).toBe(true);
    expect(screen.getByTestId('alert-settings-deals').props.value).toBe(true);
    expect(screen.getByText('Price moves')).toBeTruthy();
    expect(screen.getByText('Cards you own or watch, when they move 10%+ and $5+')).toBeTruthy();
    expect(screen.getByText('Weekly summary')).toBeTruthy();
    expect(screen.getByText('Deals under market')).toBeTruthy();
    expect(screen.getByText('Watched cards listed well below market')).toBeTruthy();
    // No limits explainer: the limits are enforced silently.
    expect(screen.queryByText(/limits/i)).toBeNull();
  });

  it('writes one switch optimistically, with the device timezone', async () => {
    const updateAlertPreferences = jest.fn(async () => ({
      prefs: { ...ALL_ON, priceMovesEnabled: false },
      status: 'ok' as const,
    }));
    renderAlerts({ updateAlertPreferences });

    const toggle = await screen.findByTestId('alert-settings-price-moves');
    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => {
      expect(updateAlertPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ priceMovesEnabled: false, timezone: expect.any(String) }),
      );
    });
    expect(updateAlertPreferences.mock.calls[0]).not.toHaveProperty('0.weeklySummaryEnabled');
    await waitFor(() => {
      expect(screen.getByTestId('alert-settings-price-moves').props.value).toBe(false);
    });
  });

  it('reverts and explains itself when the write fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderAlerts({
      updateAlertPreferences: jest.fn(async () => ({ prefs: null, status: 'failed' as const })),
    });

    const toggle = await screen.findByTestId('alert-settings-deals');
    fireEvent(toggle, 'valueChange', false);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Could not update alerts', expect.any(String));
    });
    expect(screen.getByTestId('alert-settings-deals').props.value).toBe(true);
    alertSpy.mockRestore();
  });

  it('asks for OS permission before turning a switch on, and reverts on a no', async () => {
    mockPermission.isEnabled = false;
    mockPermission.enablePushNotifications.mockResolvedValue(false);
    const updateAlertPreferences = jest.fn(async () => ({ prefs: ALL_ON, status: 'ok' as const }));
    renderAlerts({ updateAlertPreferences });

    const toggle = await screen.findByTestId('alert-settings-weekly-summary');
    expect(toggle.props.value).toBe(false); // pref on, permission off -> shown off
    fireEvent(toggle, 'valueChange', true);

    await waitFor(() => {
      expect(mockPermission.enablePushNotifications).toHaveBeenCalled();
    });
    expect(updateAlertPreferences).not.toHaveBeenCalled();
  });

  it('is reached from the Account screen', async () => {
    renderWithProviders(<AccountScreen />, { spotlightRepository: createTestSpotlightRepository() });

    fireEvent.press(await screen.findByTestId('account-alert-settings'));
    expect(mockPush).toHaveBeenCalledWith('/account/alerts');
  });
});
