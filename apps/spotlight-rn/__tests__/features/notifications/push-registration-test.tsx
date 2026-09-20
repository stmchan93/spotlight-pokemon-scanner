import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import {
  __resetPushRegistrationForTests,
  usePushPermissionPrompt,
  usePushRegistration,
} from '@/features/notifications/use-push-registration';

const mockServices = {
  sessionOwnerKey: 'owner-1',
  spotlightRepository: {
    registerPushToken: jest.fn(async () => true),
    revokePushToken: jest.fn(async () => true),
  },
};

jest.mock('@/providers/app-providers', () => ({
  useAppServices: () => mockServices,
}));

let mockAuth: { currentUser: { id: string } | null; isGuest: boolean } = {
  currentUser: { id: 'owner-1' },
  isGuest: false,
};

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => mockAuth,
}));

const notifications = Notifications as unknown as {
  getExpoPushTokenAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
};

function setPermission(status: 'granted' | 'denied' | 'undetermined') {
  notifications.getPermissionsAsync.mockResolvedValue({
    canAskAgain: status === 'undetermined',
    granted: status === 'granted',
    status,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetPushRegistrationForTests();
  mockAuth = { currentUser: { id: 'owner-1' }, isGuest: false };
  mockServices.sessionOwnerKey = 'owner-1';
  mockServices.spotlightRepository.registerPushToken.mockResolvedValue(true);
  mockServices.spotlightRepository.revokePushToken.mockResolvedValue(true);
  // The shared expo-constants mock ships an empty `extra`; a real build carries
  // the EAS project id, which `getExpoPushTokenAsync` REQUIRES.
  (Constants.expoConfig as { extra: Record<string, unknown> }).extra = {
    eas: { projectId: 'test-project-id' },
  };
  setPermission('granted');
  notifications.getExpoPushTokenAsync.mockResolvedValue({
    data: 'ExponentPushToken[mock-token]',
    type: 'expo',
  });
  notifications.requestPermissionsAsync.mockResolvedValue({
    canAskAgain: true,
    granted: true,
    status: 'granted',
  });
});

describe('usePushRegistration', () => {
  it('registers silently when permission is already granted', async () => {
    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledTimes(1);
    });
    expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({
        expoPushToken: 'ExponentPushToken[mock-token]',
        platform: 'ios',
      }),
    );
    // The one-shot iOS dialog must never be spent by the app-open path.
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('never prompts on app open when permission is undetermined', async () => {
    setPermission('undetermined');

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(notifications.getPermissionsAsync).toHaveBeenCalled();
    });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockServices.spotlightRepository.registerPushToken).not.toHaveBeenCalled();
  });

  it('does not register for a guest', async () => {
    mockAuth = { currentUser: { id: 'guest' }, isGuest: true };

    renderHook(() => usePushRegistration());

    await act(async () => {});
    expect(mockServices.spotlightRepository.registerPushToken).not.toHaveBeenCalled();
  });

  it('revokes the token once the owner signs out', async () => {
    const { rerender, unmount } = renderHook(() => usePushRegistration());
    await waitFor(() => {
      expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalled();
    });

    // Signing out remounts the provider tree, which is exactly why the
    // outstanding-token marker lives at module scope.
    unmount();
    mockAuth = { currentUser: null, isGuest: false };
    mockServices.sessionOwnerKey = 'signed-out';
    renderHook(() => usePushRegistration());
    rerender(undefined);

    await waitFor(() => {
      expect(mockServices.spotlightRepository.revokePushToken).toHaveBeenCalledWith(
        'ExponentPushToken[mock-token]',
      );
    });
  });

  it('does not revoke when nothing was ever registered', async () => {
    mockAuth = { currentUser: null, isGuest: false };

    renderHook(() => usePushRegistration());

    await act(async () => {});
    expect(mockServices.spotlightRepository.revokePushToken).not.toHaveBeenCalled();
  });
});

describe('usePushPermissionPrompt', () => {
  it('prompts and registers when permission is undetermined', async () => {
    setPermission('undetermined');
    const { result } = renderHook(() => usePushPermissionPrompt());
    await waitFor(() => {
      expect(result.current.permission).toBe('undetermined');
    });

    // The prompt flips the stored answer, like the OS does.
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      setPermission('granted');
      return { canAskAgain: false, granted: true, status: 'granted' };
    });

    let enabled = false;
    await act(async () => {
      enabled = await result.current.enablePushNotifications();
    });

    expect(enabled).toBe(true);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.isEnabled).toBe(true);
    });
  });

  it('offers the settings deep link instead of re-prompting once denied', async () => {
    setPermission('denied');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

    const { result } = renderHook(() => usePushPermissionPrompt());
    let enabled = true;
    await act(async () => {
      enabled = await result.current.enablePushNotifications();
    });

    expect(enabled).toBe(false);
    // The system dialog is spent — asking again would show nothing at all.
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    const buttons = alertSpy.mock.calls[0][2] ?? [];
    const settingsButton = buttons.find((button) => button.text === 'Open Settings');
    expect(settingsButton).toBeDefined();
    act(() => {
      settingsButton?.onPress?.();
    });
    expect(openSettingsSpy).toHaveBeenCalled();

    alertSpy.mockRestore();
    openSettingsSpy.mockRestore();
  });

  it('reports a build with no EAS project id instead of throwing', async () => {
    (Constants.expoConfig as { extra: Record<string, unknown> }).extra = {};
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { result } = renderHook(() => usePushPermissionPrompt());
    let enabled = true;
    await act(async () => {
      enabled = await result.current.enablePushNotifications();
    });

    expect(enabled).toBe(false);
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Push notifications unavailable',
      expect.stringContaining('push configuration'),
    );
    alertSpy.mockRestore();
  });
});
