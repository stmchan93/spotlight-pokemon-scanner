import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import {
  dealAlertPushCtaStorageKey,
  useDealAlertPushCta,
} from '@/features/notifications/use-deal-alert-push-cta';
import { __resetPushRegistrationForTests } from '@/features/notifications/use-push-registration';

// In-memory AsyncStorage stand-in — the real module has no native side under
// jest. State lives inside the factory so it exists when the hoisted mock runs.
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

const notifications = Notifications as unknown as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
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
  mockServices.sessionOwnerKey = 'owner-1';
  mockServices.spotlightRepository.registerPushToken.mockResolvedValue(true);
  (Constants.expoConfig as { extra: Record<string, unknown> }).extra = {
    eas: { projectId: 'test-project-id' },
  };
  setPermission('undetermined');
  notifications.requestPermissionsAsync.mockImplementation(async () => {
    setPermission('granted');
    return { canAskAgain: false, granted: true, status: 'granted' };
  });
});

describe('useDealAlertPushCta', () => {
  it('shows only while the OS has never been asked', async () => {
    const { result } = renderHook(() => useDealAlertPushCta());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });
  });

  it('stays hidden once the permission has been answered either way', async () => {
    setPermission('denied');
    const denied = renderHook(() => useDealAlertPushCta());
    await act(async () => {});
    expect(denied.result.current.isVisible).toBe(false);

    setPermission('granted');
    const granted = renderHook(() => useDealAlertPushCta());
    await act(async () => {});
    expect(granted.result.current.isVisible).toBe(false);
  });

  it('prompts on enable and never comes back', async () => {
    const { result } = renderHook(() => useDealAlertPushCta());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    await act(async () => {
      await result.current.enable();
    });

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockServices.spotlightRepository.registerPushToken).toHaveBeenCalledTimes(1);
    expect(result.current.isVisible).toBe(false);
    expect(await AsyncStorage.getItem(dealAlertPushCtaStorageKey('owner-1'))).toBe('1');
  });

  it('"Not now" retires it without spending the one-shot prompt', async () => {
    const { result, unmount } = renderHook(() => useDealAlertPushCta());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.isVisible).toBe(false);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    unmount();

    // And it stays gone on the next mount.
    const remounted = renderHook(() => useDealAlertPushCta());
    await act(async () => {});
    expect(remounted.result.current.isVisible).toBe(false);
  });

  it('scopes the dismissal per account', async () => {
    const first = renderHook(() => useDealAlertPushCta());
    await waitFor(() => {
      expect(first.result.current.isVisible).toBe(true);
    });
    act(() => {
      first.result.current.dismiss();
    });
    first.unmount();

    // A different owner on the same device has not dismissed anything.
    mockServices.sessionOwnerKey = 'owner-2';
    const second = renderHook(() => useDealAlertPushCta());
    await waitFor(() => {
      expect(second.result.current.isVisible).toBe(true);
    });
  });
});
