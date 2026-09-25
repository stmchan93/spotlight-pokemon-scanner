/**
 * `expo-sqlite`, loaded so that its absence cannot take the scanner down.
 *
 * Same shape as `notifications-module.ts`: `expo-sqlite` calls
 * `requireNativeModule` at module top level, so a static import on a binary
 * built before it was added throws during module evaluation (a JS-only OTA
 * onto an old binary). Probe the native side first, then require lazily; a
 * null here means the tray runs in memory only for this session.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type TraySQLiteModule = Pick<typeof import('expo-sqlite'), 'openDatabaseAsync'>;

// `undefined` = not tried yet, `null` = tried and unavailable.
let cachedModule: TraySQLiteModule | null | undefined;

export function loadTraySQLite(): TraySQLiteModule | null {
  if (cachedModule === undefined) {
    if (requireOptionalNativeModule('ExpoSQLite') == null) {
      cachedModule = null;
      return cachedModule;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedModule = require('expo-sqlite') as TraySQLiteModule;
    } catch {
      cachedModule = null;
    }
  }
  return cachedModule;
}
