import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Linking, Platform } from 'react-native';

import type { PushTokenPlatform, SpotlightRepository } from '@spotlight/api-client';

import { loadNotificationsModule } from '@/features/notifications/notifications-module';

/**
 * Push registration, with no React in it.
 *
 * THE PROMPT IS A ONE-SHOT RESOURCE. iOS shows the system permission dialog
 * exactly once per install; every later `requestPermissionsAsync` resolves
 * straight to the stored answer without showing anything. So nothing in here
 * asks on its own — `requestPushPermission` is only ever called from a
 * deliberate user action (the Deals-band CTA, the Account toggle), and the
 * silent path below refuses to ask at all.
 */

/** Android channel ids. Mirrors what the backend puts in the push envelope. */
export const DEALS_NOTIFICATION_CHANNEL_ID = 'deals';
export const OPS_NOTIFICATION_CHANNEL_ID = 'ops';

/**
 * A stable per-INSTALL id so the backend can replace this device's previous
 * token instead of piling up dead ones. Deliberately a random value we mint and
 * persist — not `identifierForVendor`/`ANDROID_ID` — so it carries no hardware
 * identity and needs no privacy-manifest entry. It dies with the install.
 */
const PUSH_DEVICE_ID_STORAGE_KEY = '@spotlight/notifications/device-id';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

export type PushRegistrationOutcome =
  /** Token minted and the backend took it. */
  | { status: 'registered'; token: string }
  /** Permission is not granted — the caller decides whether to prompt. */
  | { status: 'permission_missing'; permission: PushPermissionStatus }
  /** Simulator/emulator, or a build with no EAS project id. */
  | { status: 'unsupported'; reason: 'not_a_device' | 'missing_project_id' | 'no_native_module' }
  /** Permission was there; the token mint or the backend write failed. */
  | { status: 'failed' };

function resolvePushTokenPlatform(): PushTokenPlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    return Platform.OS;
  }
  return 'web';
}

/**
 * The EAS project id. REQUIRED by `getExpoPushTokenAsync` on modern SDKs — it
 * throws without one rather than guessing — and it is the only thing tying a
 * token to this project, so a build that somehow lacks it must degrade to "no
 * push" instead of exploding on launch.
 */
export function resolveEasProjectId(): string | null {
  const fromExtra = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra.trim()) {
    return fromExtra.trim();
  }
  // Present in a real build even when `expoConfig` has been trimmed.
  const fromEasConfig = Constants.easConfig?.projectId;
  if (typeof fromEasConfig === 'string' && fromEasConfig.trim()) {
    return fromEasConfig.trim();
  }
  return null;
}

export async function getPushDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(PUSH_DEVICE_ID_STORAGE_KEY);
    if (stored) {
      return stored;
    }
  } catch {
    // Fall through and mint one; an unpersisted id still registers fine, the
    // backend just sees this install as a new device next launch.
  }
  const minted = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    await AsyncStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, minted);
  } catch {
    // ignore persistence failure
  }
  return minted;
}

function resolveAppVersion(): string | null {
  return (
    Application.nativeApplicationVersion
    ?? Constants.expoConfig?.version
    ?? null
  );
}

function toPermissionStatus(value: string | null | undefined): PushPermissionStatus {
  if (value === 'granted') {
    return 'granted';
  }
  return value === 'denied' ? 'denied' : 'undetermined';
}

export async function getPushPermissionStatus(): Promise<PushPermissionStatus> {
  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    return 'undetermined';
  }
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return toPermissionStatus(status);
  } catch {
    // Treat an unreadable permission as undetermined, NOT as granted: the
    // silent path keys off `granted` and must not mint a token on a guess.
    return 'undetermined';
  }
}

/**
 * Shows the system dialog — ONCE PER INSTALL on iOS. Only call this from an
 * explicit user action.
 */
export async function requestPushPermission(): Promise<PushPermissionStatus> {
  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    // Never asked, so "undetermined" is the honest answer — not "denied".
    return 'undetermined';
  }
  try {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return toPermissionStatus(status);
  } catch {
    return 'undetermined';
  }
}

/**
 * Android needs its channels to EXIST before a notification lands, or the
 * system drops it on API 26+. There is no app.json field for a channel list
 * (the `expo-notifications` plugin only takes a single `defaultChannel`), so
 * they are created here, idempotently, on every registration.
 *
 * iOS has no channels — this is a no-op there.
 */
export async function ensureAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    return;
  }
  try {
    await Notifications.setNotificationChannelAsync(DEALS_NOTIFICATION_CHANNEL_ID, {
      name: 'Deals',
      description: 'Listings caught under your watchlist baselines.',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#7000FF',
      vibrationPattern: [0, 250, 250, 250],
    });
    await Notifications.setNotificationChannelAsync(OPS_NOTIFICATION_CHANNEL_ID, {
      name: 'Account & service',
      description: 'Sign-in, billing and service notices.',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#7000FF',
    });
  } catch {
    // A channel that can't be created costs delivery on Android, not a crash.
  }
}

/**
 * Show a push that arrives while the app is FOREGROUNDED. Without a handler
 * expo-notifications suppresses it, which reads as "deals silently stopped"
 * whenever the app happens to be open.
 */
export function configureForegroundNotificationHandler(): void {
  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Mint this device's Expo push token and hand it to the backend.
 *
 * `promptIfNeeded` is the whole permission policy in one flag: false (the app
 * -open path) returns `permission_missing` rather than spending the one-shot
 * iOS dialog; true is only ever passed from a user-initiated CTA.
 */
export async function registerPushToken(
  repository: SpotlightRepository,
  options: { promptIfNeeded?: boolean } = {},
): Promise<PushRegistrationOutcome> {
  // Simulators and emulators cannot mint a push token at all — Expo's call
  // rejects there — so bail before touching permissions.
  if (!Device.isDevice) {
    return { status: 'unsupported', reason: 'not_a_device' };
  }

  const projectId = resolveEasProjectId();
  if (!projectId) {
    return { status: 'unsupported', reason: 'missing_project_id' };
  }

  let permission = await getPushPermissionStatus();
  if (permission !== 'granted') {
    if (!options.promptIfNeeded) {
      return { status: 'permission_missing', permission };
    }
    permission = await requestPushPermission();
    if (permission !== 'granted') {
      return { status: 'permission_missing', permission };
    }
  }

  // Channels first: Android binds the token's default channel at mint time.
  await ensureAndroidNotificationChannels();

  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    return { status: 'unsupported', reason: 'no_native_module' };
  }

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data.trim();
  } catch {
    return { status: 'failed' };
  }
  if (!token) {
    return { status: 'failed' };
  }

  const accepted = await repository.registerPushToken({
    appVersion: resolveAppVersion(),
    deviceId: await getPushDeviceId(),
    expoPushToken: token,
    platform: resolvePushTokenPlatform(),
  });
  return accepted ? { status: 'registered', token } : { status: 'failed' };
}

/**
 * Retire this device's token. Called on sign-out so the next account on the
 * phone cannot inherit the previous owner's deal alerts — the same
 * owner-scoping rule that governs every other persisted account surface.
 *
 * Reads the token WITHOUT prompting: if permission is already gone there is
 * nothing to revoke, and asking at sign-out would be the worst possible moment.
 */
export async function revokePushToken(repository: SpotlightRepository): Promise<boolean> {
  if (!Device.isDevice) {
    return false;
  }
  const projectId = resolveEasProjectId();
  if (!projectId) {
    return false;
  }
  if ((await getPushPermissionStatus()) !== 'granted') {
    return false;
  }
  const Notifications = loadNotificationsModule();
  if (!Notifications) {
    return false;
  }
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = data.trim();
    return token ? await repository.revokePushToken(token) : false;
  } catch {
    return false;
  }
}

/**
 * Open the OS settings page for this app — the only route back once someone has
 * denied, because the system dialog will never appear again.
 */
export async function openNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Nothing useful to do if the OS refuses to open its own settings.
  }
}
