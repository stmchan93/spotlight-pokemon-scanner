import { Platform } from 'react-native';
import Constants from 'expo-constants';

import type { PushPlatform } from '@spotlight/api-client';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

export type PushRegistration = {
  token: string | null;
  status: PushPermissionStatus;
};

type ExpoNotificationsModule = {
  getPermissionsAsync: () => Promise<{ status: string; granted?: boolean }>;
  requestPermissionsAsync: () => Promise<{ status: string; granted?: boolean }>;
  getExpoPushTokenAsync: (options?: { projectId?: string }) => Promise<{ data: string }>;
  setNotificationChannelAsync?: (
    channelId: string,
    channel: {
      name: string;
      importance: number;
      sound?: string | null;
      vibrationPattern?: number[];
      lightColor?: string;
    },
  ) => Promise<unknown>;
  AndroidImportance?: {
    DEFAULT: number;
    HIGH: number;
    MAX: number;
    MIN: number;
    LOW: number;
    NONE: number;
    UNSPECIFIED: number;
  };
};

/**
 * Resolve the current Expo platform tag for push token registration. Falls
 * back to `null` on unsupported platforms so the caller can skip registering
 * a token rather than guess.
 */
export function resolvePushPlatform(): PushPlatform | null {
  switch (Platform.OS) {
    case 'ios':
      return 'ios';
    case 'android':
      return 'android';
    case 'web':
      return 'web';
    default:
      return null;
  }
}

function loadExpoNotifications(): ExpoNotificationsModule | null {
  try {
    // Wrapped in try/catch because `expo-notifications` is not available in
    // Expo Go (SDK 53+ removed remote-push support) nor under jest unless we
    // mock it. The caller treats a missing module as "no push" gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as ExpoNotificationsModule;
    return mod ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the EAS project id from the runtime Expo config. Returns `null`
 * when it is not configured (e.g. in jest, Expo Go, or the dev client
 * before EAS init), which lets `getExpoPushTokenAsync` infer the project
 * automatically when running on a real device.
 */
function resolveEasProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const projectId = extra?.eas?.projectId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    return null;
  }
  return projectId.trim();
}

/**
 * Configure the default Android notification channel. Safe to call on iOS
 * (no-op). Should be invoked once at app start (e.g. from `app-providers`).
 */
export async function setupAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const notifications = loadExpoNotifications();
  if (!notifications?.setNotificationChannelAsync) {
    return;
  }
  const importance = notifications.AndroidImportance?.DEFAULT ?? 3;
  try {
    await notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance,
    });
  } catch {
    // Channel setup is best-effort; failure should not block app startup.
  }
}

/**
 * Request notification permissions (if not already granted) and resolve an
 * Expo push token for this device. Returns `{ token: null, status }` when
 * the user denied permission or when the runtime cannot issue a token
 * (simulator, web, Expo Go, missing module). Never throws.
 */
export async function registerForPushNotifications(): Promise<PushRegistration> {
  const notifications = loadExpoNotifications();
  if (!notifications) {
    return { token: null, status: 'undetermined' };
  }

  let status: PushPermissionStatus = 'undetermined';
  try {
    const current = await notifications.getPermissionsAsync();
    status = normalizePermissionStatus(current.status, current.granted);
    if (status !== 'granted') {
      const requested = await notifications.requestPermissionsAsync();
      status = normalizePermissionStatus(requested.status, requested.granted);
    }
  } catch {
    return { token: null, status: 'undetermined' };
  }

  if (status !== 'granted') {
    return { token: null, status };
  }

  try {
    const projectId = resolveEasProjectId();
    const tokenResponse = await notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = typeof tokenResponse?.data === 'string' && tokenResponse.data.length > 0
      ? tokenResponse.data
      : null;
    return { token, status };
  } catch {
    // Simulator/Expo Go can't issue a token; surface that as null rather
    // than an error so callers can no-op cleanly.
    return { token: null, status };
  }
}

function normalizePermissionStatus(
  status: string | null | undefined,
  granted: boolean | undefined,
): PushPermissionStatus {
  if (granted === true) {
    return 'granted';
  }
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    default:
      return 'undetermined';
  }
}
