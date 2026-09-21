/**
 * `expo-notifications`, loaded so that its ABSENCE cannot take the app down.
 *
 * It is a native module, and every binary built before it was added lacks the
 * native half. `requireNativeModule` — which expo-notifications calls at module
 * top level — THROWS when the native side is missing, so a static
 * `import * as Notifications from 'expo-notifications'` fails during module
 * evaluation. That propagates through the bridge into the root layout, i.e. a
 * white screen on launch for everyone on the old binary.
 *
 * That is exactly the shape of a JS-only OTA: the JS ships, the native module
 * does not. Loading it lazily behind a try/catch keeps the failure local — push
 * reports itself unavailable and the rest of the app is untouched — so the
 * feature can ride an OTA and simply switch on when a native build lands.
 *
 * A try/catch around `require` is NOT enough on its own: babel-preset-expo
 * lazy-loads a package's re-exports, so `require('expo-notifications')`
 * succeeds and the throw is deferred to the first member access — inside a
 * React effect, where it crashed staging 1.2.0 (11) on 2026-09-21. So probe the
 * native side directly first.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type NotificationsModule = typeof import('expo-notifications');

// Any expo-notifications native module works as the probe: they ship together.
const PROBE_NATIVE_MODULE = 'ExpoPushTokenManager';

// `undefined` = not tried yet, `null` = tried and unavailable.
let cachedModule: NotificationsModule | null | undefined;

/** The native module, or null when this binary does not carry it. */
export function loadNotificationsModule(): NotificationsModule | null {
  if (cachedModule === undefined) {
    if (requireOptionalNativeModule(PROBE_NATIVE_MODULE) == null) {
      cachedModule = null;
      return cachedModule;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedModule = require('expo-notifications') as NotificationsModule;
    } catch {
      cachedModule = null;
    }
  }
  return cachedModule;
}

/** Whether push can work at all in this binary. False on a pre-push build. */
export function isPushNativeModuleAvailable(): boolean {
  return loadNotificationsModule() != null;
}

/** Test seam: forget the cached answer. */
export function resetNotificationsModuleCache(): void {
  cachedModule = undefined;
}
