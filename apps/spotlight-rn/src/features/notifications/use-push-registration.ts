import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import { useAuth } from '@/providers/auth-provider';
import { useAppServices } from '@/providers/app-providers';
import {
  configureForegroundNotificationHandler,
  getPushPermissionStatus,
  openNotificationSettings,
  registerPushToken,
  revokePushToken,
  type PushPermissionStatus,
} from '@/features/notifications/push-notifications';

/**
 * Which owner this device's push token is currently registered for.
 *
 * MODULE level, not state, and that is load-bearing. Signing out changes
 * `AppProviders`' remount key, so the component holding this hook is torn down
 * and rebuilt — a `useRef` would come back empty and the sign-out transition
 * would be invisible. This survives the remount, so the freshly-mounted
 * signed-out tree can still see that a token is outstanding and retire it.
 */
let registeredOwnerKey: string | null = null;

/** Test seam: the module-level key above outlives `jest.resetModules()` sparingly. */
export function __resetPushRegistrationForTests(): void {
  registeredOwnerKey = null;
}

/**
 * Root-layout hook. Keeps the backend's copy of this device's Expo push token
 * in step with who is signed in.
 *
 * NEVER PROMPTS. `registerPushToken` is called without `promptIfNeeded`, so a
 * user who has not been asked yet stays un-asked: iOS spends its one and only
 * permission dialog the first time it is requested, and burning that on app
 * launch — before anyone has seen a deal — is unrecoverable. The prompt belongs
 * to `usePushPermissionPrompt`, behind a deliberate tap.
 */
export function usePushRegistration(): void {
  const { sessionOwnerKey, spotlightRepository } = useAppServices();
  const auth = useAuth();
  // A guest has no server-side owner to attach a token to.
  const isSignedIn = Boolean(auth.currentUser) && !auth.isGuest;

  useEffect(() => {
    configureForegroundNotificationHandler();
  }, []);

  const syncRegistration = useCallback(async () => {
    if (!isSignedIn) {
      if (registeredOwnerKey !== null) {
        registeredOwnerKey = null;
        // Best effort: by the time the signed-out tree mounts the session is
        // already gone, so the authenticated revoke in the Account screen's
        // sign-out is the primary path and this is the backstop.
        await revokePushToken(spotlightRepository);
      }
      return;
    }
    const outcome = await registerPushToken(spotlightRepository);
    registeredOwnerKey = outcome.status === 'registered' ? sessionOwnerKey : null;
  }, [isSignedIn, sessionOwnerKey, spotlightRepository]);

  useEffect(() => {
    void syncRegistration();
  }, [syncRegistration]);

  // Someone can flip the OS switch from Settings while we are backgrounded, and
  // a token minted before that is not necessarily the one the OS now honours.
  // Re-running on foreground is the cheapest way to pick that up; it still
  // cannot prompt, so there is no risk of an ambush dialog on resume.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void syncRegistration();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [syncRegistration]);
}

export type PushPermissionPrompt = {
  permission: PushPermissionStatus;
  /** True once the OS will actually deliver — the value a Switch should show. */
  isEnabled: boolean;
  isBusy: boolean;
  /**
   * The ONLY place the system dialog is raised. Call from a deliberate tap.
   *
   * - `undetermined` → prompts, then registers the token on a yes.
   * - `denied` → the dialog is spent, so it offers the OS settings page instead.
   * - `granted` → re-registers (cheap, idempotent).
   *
   * Resolves to whether push is on afterwards.
   */
  enablePushNotifications: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

/**
 * The contextual permission entry point, shared by the Deals-band CTA and the
 * Account screen's switch.
 */
export function usePushPermissionPrompt(): PushPermissionPrompt {
  const { sessionOwnerKey, spotlightRepository } = useAppServices();
  const [permission, setPermission] = useState<PushPermissionStatus>('undetermined');
  const [isBusy, setIsBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await getPushPermissionStatus();
    if (mountedRef.current) {
      setPermission(next);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enablePushNotifications = useCallback(async () => {
    if (isBusy) {
      return permission === 'granted';
    }
    setIsBusy(true);
    try {
      // Read fresh rather than trusting state: the user may have changed this
      // in Settings since the last render.
      const current = await getPushPermissionStatus();
      if (current === 'denied') {
        if (mountedRef.current) {
          setPermission('denied');
        }
        Alert.alert(
          'Notifications are off',
          'Turn on notifications for Ekalight in Settings to get deal alerts.',
          [
            { style: 'cancel', text: 'Not now' },
            {
              onPress: () => {
                void openNotificationSettings();
              },
              text: 'Open Settings',
            },
          ],
        );
        return false;
      }

      const outcome = await registerPushToken(spotlightRepository, { promptIfNeeded: true });
      const next = outcome.status === 'permission_missing'
        ? outcome.permission
        : await getPushPermissionStatus();
      if (mountedRef.current) {
        setPermission(next);
      }
      if (outcome.status === 'registered') {
        // Claim the outstanding token for this owner NOW rather than waiting on
        // the root hook's next pass, so a sign-out immediately after enabling
        // still has something to revoke.
        registeredOwnerKey = sessionOwnerKey;
        return true;
      }
      // A simulator or a missing project id can't ever deliver; say so once
      // rather than leaving a switch that silently refuses to move.
      if (outcome.status === 'unsupported') {
        Alert.alert(
          'Push notifications unavailable',
          outcome.reason === 'not_a_device'
            ? 'Deal alerts need a real device — the simulator cannot receive push notifications.'
            : 'This build is missing its push configuration.',
        );
        return false;
      }
      if (outcome.status === 'failed') {
        Alert.alert(
          'Could not turn on deal alerts',
          'Something went wrong setting up notifications. Please try again.',
        );
      }
      return false;
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }, [isBusy, permission, sessionOwnerKey, spotlightRepository]);

  return {
    enablePushNotifications,
    isBusy,
    isEnabled: permission === 'granted',
    permission,
    refresh,
  };
}
