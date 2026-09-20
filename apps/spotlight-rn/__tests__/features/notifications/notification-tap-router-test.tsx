import { renderHook, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';

import { useNotificationTapRouter } from '@/features/notifications/use-notification-tap-router';

const mockPush = jest.fn();
let mockNavigationState: { key: string } | undefined = { key: 'root' };

jest.mock('expo-router', () => ({
  useRootNavigationState: () => mockNavigationState,
  useRouter: () => ({ push: mockPush }),
}));

const mockServices = {
  sessionOwnerKey: 'owner-1',
  spotlightRepository: {
    markDealAlertTapped: jest.fn(async () => null),
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
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock;
};

function makeResponse(identifier: string, data: Record<string, unknown>) {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        content: { data },
        identifier,
      },
    },
  };
}

const DEAL_DATA = {
  alertId: 'alert-1',
  cardId: 'sm7-1',
  type: 'deal_alert',
  // The route kept its internal name even though the UI says "Watchlist".
  url: '/wishlist',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNavigationState = { key: 'root' };
  mockAuth = { currentUser: { id: 'owner-1' }, isGuest: false };
  notifications.getLastNotificationResponseAsync.mockResolvedValue(null);
  notifications.addNotificationResponseReceivedListener.mockReturnValue({ remove: jest.fn() });
});

describe('useNotificationTapRouter', () => {
  it('routes a COLD START tap and stamps the alert', async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(
      makeResponse('cold-1', DEAL_DATA),
    );

    renderHook(() => useNotificationTapRouter());

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/wishlist');
    });
    await waitFor(() => {
      expect(mockServices.spotlightRepository.markDealAlertTapped).toHaveBeenCalledWith('alert-1');
    });
  });

  it('routes a WARM tap through the response listener', async () => {
    renderHook(() => useNotificationTapRouter());
    await waitFor(() => {
      expect(notifications.addNotificationResponseReceivedListener).toHaveBeenCalled();
    });

    const listener = notifications.addNotificationResponseReceivedListener.mock.calls[0][0];
    await waitFor(() => {
      listener(makeResponse('warm-1', DEAL_DATA));
      expect(mockPush).toHaveBeenCalledWith('/wishlist');
    });
  });

  it('handles the same response only once when both paths deliver it', async () => {
    const response = makeResponse('cold-1', DEAL_DATA);
    notifications.getLastNotificationResponseAsync.mockResolvedValue(response);

    renderHook(() => useNotificationTapRouter());
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });

    const listener = notifications.addNotificationResponseReceivedListener.mock.calls[0][0];
    listener(response);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
  });

  it('holds the tap until the navigator exists', async () => {
    mockNavigationState = undefined;
    notifications.getLastNotificationResponseAsync.mockResolvedValue(
      makeResponse('cold-1', DEAL_DATA),
    );

    const { rerender } = renderHook(() => useNotificationTapRouter());
    await waitFor(() => {
      expect(notifications.getLastNotificationResponseAsync).toHaveBeenCalled();
    });
    expect(mockPush).not.toHaveBeenCalled();

    mockNavigationState = { key: 'root' };
    rerender(undefined);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/wishlist');
    });
  });

  it('does not route a signed-out viewer into the watchlist', async () => {
    mockAuth = { currentUser: null, isGuest: false };
    notifications.getLastNotificationResponseAsync.mockResolvedValue(
      makeResponse('cold-1', DEAL_DATA),
    );

    renderHook(() => useNotificationTapRouter());
    await waitFor(() => {
      expect(notifications.getLastNotificationResponseAsync).toHaveBeenCalled();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('routes a payload with no alert id without stamping anything', async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(
      makeResponse('cold-2', { type: 'ops', url: '/account' }),
    );

    renderHook(() => useNotificationTapRouter());
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/account');
    });
    expect(mockServices.spotlightRepository.markDealAlertTapped).not.toHaveBeenCalled();
  });
});
