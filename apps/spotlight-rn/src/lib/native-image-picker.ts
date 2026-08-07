import { requireOptionalNativeModule } from 'expo-modules-core';

/** The Expo native module name expo-image-picker registers on the client. */
const IMAGE_PICKER_NATIVE_MODULE = 'ExpoImagePicker';

/**
 * `expo-image-picker`'s JavaScript ships in every OTA bundle, but its NATIVE
 * half only exists in binaries built after the package was added to the app
 * (2026-07-22 — the iOS staging build in the field is from 2026-07-21). On an
 * older binary `require('expo-image-picker')` still succeeds, so a truthiness
 * check on the module passes and the first real call reaches a native side that
 * isn't there: the composer's Photo and Camera chips took the whole app down.
 *
 * Probe the native registry instead of trusting the require, and return null
 * when it's missing so callers can say "update needed" rather than crash. Once a
 * native build ships with the module (and the Info.plist photo-library string
 * its config plugin injects), this resolves normally.
 */
export function loadNativeImagePicker(): typeof import('expo-image-picker') | null {
  if (!requireOptionalNativeModule(IMAGE_PICKER_NATIVE_MODULE)) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as typeof import('expo-image-picker');
  } catch {
    return null;
  }
}
