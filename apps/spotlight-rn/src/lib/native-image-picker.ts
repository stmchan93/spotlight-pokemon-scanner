import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * The Expo native module name expo-image-picker registers on the client.
 *
 * It is "Exponent…", NOT "Expo…" — the package kept the legacy prefix that most
 * other Expo modules dropped (ImagePickerModule.swift / ImagePickerModule.kt
 * both declare `Name("ExponentImagePicker")`, and the library's own JS does
 * `requireNativeModule('ExponentImagePicker')`).
 *
 * Getting this wrong is silent and total: `requireOptionalNativeModule` returns
 * null for an unknown name exactly as it does for a genuinely missing module, so
 * a typo here disables Photo, Camera, and avatar upload on EVERY build while
 * telling the user to update an app that is already current. It did — that is
 * why `native-image-picker-test.ts` pins this string against the installed
 * package rather than trusting it by eye.
 */
const IMAGE_PICKER_NATIVE_MODULE = 'ExponentImagePicker';

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
