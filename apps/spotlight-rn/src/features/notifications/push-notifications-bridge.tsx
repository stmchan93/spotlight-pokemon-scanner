import { useNotificationTapRouter } from '@/features/notifications/use-notification-tap-router';
import {
  useFirstLaunchPushPrompt,
  usePushRegistration,
} from '@/features/notifications/use-push-registration';

/**
 * Renderless. Mounted ONCE from the root layout, inside the app providers (it
 * needs the repository and the auth session) and beside the navigator (it needs
 * the router). Everything it does is an effect:
 *
 * - keeps this device's Expo push token in step with who is signed in, without
 *   ever raising the permission dialog, and
 * - routes a tapped notification, cold start or warm.
 */
export function PushNotificationsBridge() {
  usePushRegistration();
  useNotificationTapRouter();
  return null;
}

/**
 * Renderless. The one-time first-launch permission ask — mounted INSIDE the
 * auth, access and @handle gates so the dialog never lands on those screens.
 */
export function FirstLaunchPushPrompt() {
  useFirstLaunchPushPrompt();
  return null;
}
