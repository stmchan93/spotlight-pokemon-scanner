import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Alert, AppState, Linking } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import {
  __resetPushRegistrationForTests,
  useFirstLaunchPushPrompt,
  usePushPermissionPrompt,
  usePushRegistration,
} from '@/features/notifications/use-push-registration';

// In-memory AsyncStorage stand-in; state lives in the factory for hoisting.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      __clear: () => store.clear(),
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  };
});

const storage = AsyncStorage as unknown as { __clear: () => void };

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
  storage.__clear();
  AppState.currentState = 'active';
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

  it('never prompts, even when permission was never asked', async () => {
    setPermission('undetermined');

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(notifications.getPermissionsAsync).toHaveBeenCalled();
    });
    await act(async () => {});
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockServices.spotlightRepository.registerPushToken).not.toHaveBeenCalled();
  });

  it('does not ask a guest', async () => {
    setPermission('undetermined');
    AppState.currentState = 'active';
    mockAuth = { currentUser: { id: 'guest-1' }, isGuest: true };

    renderHook(() => usePushRegistration());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
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

describe('useFirstLaunchPushPrompt', () => {
  function grantOnPrompt() {
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      setPermission('granted');
      return { canAskAgain: false, granted: true, status: 'granted' };
    });
  }

  it('asks once on first launch and registers the token after a yes', async () => {
    setPermission('undetermined');
    grantOnPrompt();

    renderHook(() => useFirstLaunchPushPrompt());

    await waitFor(() => {
      expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledTimes(1);
    });
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({ expoPushToken: 'ExponentPushToken[mock-token]' }),
    );
  });

  it('never asks twice on the same install, whatever the answer', async () => {
    setPermission('undetermined');
    // A dismissed/declined dialog: the OS answer stays unresolved here.
    notifications.requestPermissionsAsync.mockResolvedValue({
      canAskAgain: true,
      granted: false,
      status: 'undetermined',
    });

    const first = renderHook(() => useFirstLaunchPushPrompt());
    await waitFor(() => {
      expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    // Next launch: fresh process state, same install storage.
    __resetPushRegistrationForTests();
    renderHook(() => useFirstLaunchPushPrompt());
    await act(async () => {});

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not ask when permission was already denied', async () => {
    setPermission('denied');

    renderHook(() => useFirstLaunchPushPrompt());

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('waits for a real session instead of asking a guest', async () => {
    setPermission('undetermined');
    grantOnPrompt();
    mockAuth = { currentUser: { id: 'guest-1' }, isGuest: true };

    const { rerender } = renderHook(() => useFirstLaunchPushPrompt());
    await act(async () => {});
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    // Converting to a real account still gets the one ask.
    mockAuth = { currentUser: { id: 'owner-1' }, isGuest: false };
    rerender({});
    await waitFor(() => {
      expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('holds the ask until the app is in the foreground', async () => {
    setPermission('undetermined');
    AppState.currentState = 'background';

    renderHook(() => useFirstLaunchPushPrompt());
    await act(async () => {});

    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
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
