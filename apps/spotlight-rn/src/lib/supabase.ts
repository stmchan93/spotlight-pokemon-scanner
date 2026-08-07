import { AppState, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';

import { resolveExpoScheme, resolveRuntimeValue } from './runtime-config';

type AsyncStorageModule = (typeof import('@react-native-async-storage/async-storage'))['default'];
type SecureStoreModule = typeof import('expo-secure-store');
type SecureStoreOptions = import('expo-secure-store').SecureStoreOptions;
type WebBrowserModule = typeof import('expo-web-browser');

let secureStoreModule: SecureStoreModule | null = null;
let webBrowserModule: WebBrowserModule | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secureStoreModule = require('expo-secure-store') as SecureStoreModule;
} catch {
  secureStoreModule = null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  webBrowserModule = require('expo-web-browser') as WebBrowserModule;
} catch {
  webBrowserModule = null;
}

void webBrowserModule?.maybeCompleteAuthSession();

type SupabaseAuthConfig = {
  anonKey: string;
  configurationIssue: string | null;
  isConfigured: boolean;
  redirectURL: string;
  supabaseURL: string;
};

/**
 * Session storage is billing-critical. Supabase counts a monthly active user as
 * any distinct user who signs in OR refreshes a token in the cycle, so a session
 * that does not survive process death forces a fresh sign-in and mints a brand
 * new billable identity (and a new analytics person) on every cold start.
 *
 * Tiers, in order of preference:
 *   1. expo-secure-store (Keychain / Android Keystore) — encrypted, the default.
 *   2. AsyncStorage — plaintext but PERSISTENT, used only once the keychain has
 *      proven unusable on this device.
 *   3. An in-memory Map — last resort so the adapter can never throw into
 *      supabase-js when even AsyncStorage is missing (tests, odd runtimes).
 */
export type SecureStoreFallbackReason =
  | 'delete_failed'
  | 'module_unavailable'
  | 'previously_engaged'
  | 'read_failed'
  | 'write_failed';

export type SecureStoreFallbackState = {
  errorCode: string | null;
  isUsingFallbackStorage: boolean;
  reason: SecureStoreFallbackReason | null;
};

const FALLBACK_VALUE_KEY_PREFIX = '@spotlight/auth/secure-store-fallback/';
const FALLBACK_ENGAGED_KEY = '@spotlight/auth/secure-store-fallback-engaged';
const SECURE_STORE_FALLBACK_EVENT = 'auth_secure_store_fallback_engaged';

const memoryStorage = new Map<string, string>();

let asyncStorageModule: AsyncStorageModule | null | undefined;
let shouldUseFallbackStorage = secureStoreModule == null;
let fallbackReason: SecureStoreFallbackReason | null = secureStoreModule == null
  ? 'module_unavailable'
  : null;
let fallbackErrorCode: string | null = null;
let hasReportedFallback = false;
let fallbackFlagLoad: Promise<void> | null = null;

// Keys we must never pull back out of the keychain: either we already tried, or
// the value was signed out (migrating then would resurrect a dead session).
const skipSecureStoreMigration = new Set<string>();

/**
 * The default keychain accessibility is `WHEN_UNLOCKED`, which makes the refresh
 * token unreadable while the device is locked — a background token refresh then
 * fails and the session is dropped. `AFTER_FIRST_UNLOCK` keeps the item readable
 * once the device has been unlocked at least since boot.
 *
 * Only the write path applies it (expo-secure-store's iOS query builder omits
 * `kSecAttrAccessible` for reads/deletes, so existing `WHEN_UNLOCKED` items stay
 * readable), but the option bag is shared by all three APIs so it is passed
 * uniformly.
 */
function buildSecureStoreOptions(): SecureStoreOptions {
  const keychainAccessible = secureStoreModule?.AFTER_FIRST_UNLOCK;
  if (typeof keychainAccessible !== 'number') {
    return {};
  }

  return { keychainAccessible };
}

const secureStoreOptions = buildSecureStoreOptions();

function getAsyncStorage(): AsyncStorageModule | null {
  if (asyncStorageModule !== undefined) {
    return asyncStorageModule;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require('@react-native-async-storage/async-storage') as {
      default?: AsyncStorageModule;
    };
    asyncStorageModule = required?.default ?? (required as AsyncStorageModule | undefined) ?? null;
  } catch {
    asyncStorageModule = null;
  }

  return asyncStorageModule ?? null;
}

function fallbackValueKey(key: string) {
  return `${FALLBACK_VALUE_KEY_PREFIX}${key}`;
}

function isKeychainFallbackError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? (error as { code?: unknown }).code : null;
  if (typeof code === 'string' && code === 'ERR_KEY_CHAIN') {
    return true;
  }

  const message = 'message' in error ? (error as { message?: unknown }).message : null;
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return normalized.includes('required entitlement')
    || normalized.includes('keychain-access-groups')
    || normalized.includes('keychain');
}

function resolveErrorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }

  return 'unknown';
}

/**
 * Emitted once per process. The PostHog module is pulled in lazily so this
 * low-level module keeps a leaf import graph — `observability/posthog` drags in
 * React and the PostHog client, and the auth provider imports both this module
 * and that one. Analytics must never be able to break authentication, so every
 * failure here is swallowed.
 */
function reportSecureStoreFallback() {
  if (hasReportedFallback) {
    return;
  }

  hasReportedFallback = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const observability = require('./observability/posthog') as typeof import('./observability/posthog');
    observability.capturePostHogEvent(SECURE_STORE_FALLBACK_EVENT, {
      error_code: fallbackErrorCode,
      reason: fallbackReason,
    });
  } catch {
    // Ignored on purpose.
  }
}

async function persistFallbackFlag() {
  const storage = getAsyncStorage();
  if (!storage) {
    return;
  }

  try {
    await storage.setItem(FALLBACK_ENGAGED_KEY, fallbackErrorCode ?? fallbackReason ?? 'unknown');
  } catch {
    // Best effort: the next launch simply retries the keychain first.
  }
}

async function clearFallbackFlag() {
  const storage = getAsyncStorage();
  if (!storage) {
    return;
  }

  try {
    await storage.removeItem(FALLBACK_ENGAGED_KEY);
  } catch {
    // Best effort.
  }
}

/**
 * Once the keychain has failed on a device, later cold starts must NOT read the
 * keychain first: it still holds the pre-failure token, and handing supabase-js
 * a stale refresh token logs the user out — the exact new-billable-identity bug
 * this tier exists to prevent. The marker is cleared on sign-out, so a device
 * that recovers gets the keychain back on its next sign-in.
 */
async function ensureFallbackFlagLoaded() {
  if (fallbackFlagLoad) {
    await fallbackFlagLoad;
    return;
  }

  if (shouldUseFallbackStorage) {
    return;
  }

  fallbackFlagLoad = (async () => {
    const storage = getAsyncStorage();
    if (!storage) {
      return;
    }

    try {
      const flag = await storage.getItem(FALLBACK_ENGAGED_KEY);
      if (typeof flag === 'string' && flag.length > 0 && !shouldUseFallbackStorage) {
        shouldUseFallbackStorage = true;
        fallbackReason = 'previously_engaged';
        fallbackErrorCode = flag;
      }
    } catch {
      // Best effort: fall through and try the keychain.
    }
  })();

  await fallbackFlagLoad;
}

function engageFallbackStorage(reason: SecureStoreFallbackReason, error: unknown) {
  if (!shouldUseFallbackStorage) {
    shouldUseFallbackStorage = true;
    fallbackReason = reason;
    fallbackErrorCode = resolveErrorCode(error);
    void persistFallbackFlag();
  }

  reportSecureStoreFallback();
}

async function readFallbackValue(key: string) {
  const storage = getAsyncStorage();
  if (storage) {
    try {
      const value = await storage.getItem(fallbackValueKey(key));
      if (typeof value === 'string') {
        return value;
      }
    } catch {
      // Fall through to the in-memory tier.
    }
  }

  return memoryStorage.get(key) ?? null;
}

async function writeFallbackValue(key: string, value: string) {
  // This value now supersedes anything left in the keychain for this key.
  skipSecureStoreMigration.add(key);
  // Mirrored in memory so a failed AsyncStorage write still serves this process.
  memoryStorage.set(key, value);

  const storage = getAsyncStorage();
  if (!storage) {
    return;
  }

  try {
    await storage.setItem(fallbackValueKey(key), value);
  } catch {
    // Never throw into supabase-js; the in-memory tier already holds the value.
  }
}

async function removeFallbackValue(key: string) {
  memoryStorage.delete(key);

  const storage = getAsyncStorage();
  if (!storage) {
    return;
  }

  try {
    await storage.removeItem(fallbackValueKey(key));
  } catch {
    // Never throw into supabase-js.
  }
}

/**
 * Carry an existing keychain session into the fallback tier the first time we
 * need it, so users who were signed in before the fallback engaged (or before
 * this code shipped) are not signed out.
 */
async function migrateSecureStoreValue(key: string) {
  if (!secureStoreModule || skipSecureStoreMigration.has(key)) {
    return null;
  }

  skipSecureStoreMigration.add(key);

  try {
    const existing = await secureStoreModule.getItemAsync(key, secureStoreOptions);
    if (typeof existing === 'string' && existing.length > 0) {
      await writeFallbackValue(key, existing);
      return existing;
    }
  } catch {
    // The keychain is precisely what failed; there is nothing to migrate.
  }

  return null;
}

async function readFromSecureStore(key: string) {
  await ensureFallbackFlagLoaded();

  if (secureStoreModule && !shouldUseFallbackStorage) {
    try {
      const value = await secureStoreModule.getItemAsync(key, secureStoreOptions);
      if (typeof value === 'string') {
        return value;
      }

      // A keychain miss can still mean an earlier process (or an install without
      // the native module) persisted the session in the fallback tier, so never
      // report "signed out" without checking it.
      return await readFallbackValue(key);
    } catch (error) {
      if (!isKeychainFallbackError(error)) {
        throw error;
      }

      // Reading this key just threw, so there is nothing to migrate from it.
      skipSecureStoreMigration.add(key);
      engageFallbackStorage('read_failed', error);
    }
  }

  reportSecureStoreFallback();

  const persisted = await readFallbackValue(key);
  if (persisted != null) {
    return persisted;
  }

  return migrateSecureStoreValue(key);
}

async function writeToSecureStore(key: string, value: string) {
  await ensureFallbackFlagLoaded();

  if (secureStoreModule && !shouldUseFallbackStorage) {
    try {
      await secureStoreModule.setItemAsync(key, value, secureStoreOptions);
      return;
    } catch (error) {
      if (!isKeychainFallbackError(error)) {
        throw error;
      }

      engageFallbackStorage('write_failed', error);
    }
  }

  reportSecureStoreFallback();
  await writeFallbackValue(key, value);
}

async function removeFromSecureStore(key: string) {
  await ensureFallbackFlagLoaded();

  // Sign-out must clear BOTH tiers, and must stop migration from resurrecting a
  // keychain copy we may not have been able to delete.
  skipSecureStoreMigration.add(key);
  await removeFallbackValue(key);
  void clearFallbackFlag();

  if (secureStoreModule && !shouldUseFallbackStorage) {
    try {
      await secureStoreModule.deleteItemAsync(key, secureStoreOptions);
      return;
    } catch (error) {
      if (!isKeychainFallbackError(error)) {
        throw error;
      }

      engageFallbackStorage('delete_failed', error);
    }
  }

  reportSecureStoreFallback();
}

export function getSecureStoreFallbackState(): SecureStoreFallbackState {
  return {
    errorCode: fallbackErrorCode,
    isUsingFallbackStorage: shouldUseFallbackStorage,
    reason: fallbackReason,
  };
}

const secureStoreAdapter = {
  getItem: async (key: string) => {
    return readFromSecureStore(key);
  },
  removeItem: async (key: string) => {
    await removeFromSecureStore(key);
  },
  setItem: async (key: string, value: string) => {
    await writeToSecureStore(key, value);
  },
};

let hasRegisteredAutoRefreshListener = false;

export function resolveSupabaseAuthConfig(): SupabaseAuthConfig {
  const supabaseURL = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_URL',
    ],
    ['spotlightSupabaseUrl'],
  );
  const anonKey = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    ],
    ['spotlightSupabaseAnonKey'],
  );
  const redirectHost = resolveRuntimeValue(
    ['EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST'],
    ['spotlightAuthRedirectHost'],
  ) || 'login-callback';
  const redirectURL = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL',
      'EXPO_PUBLIC_SUPABASE_REDIRECT_URL',
    ],
    ['spotlightAuthRedirectUrl'],
  ) || makeRedirectUri({
    path: redirectHost,
    scheme: resolveExpoScheme(),
  });

  if (!supabaseURL) {
    return {
      anonKey,
      configurationIssue: 'Supabase URL is missing. Set EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL.',
      isConfigured: false,
      redirectURL,
      supabaseURL,
    };
  }

  if (!anonKey) {
    return {
      anonKey,
      configurationIssue: 'Supabase anon key is missing. Set EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY.',
      isConfigured: false,
      redirectURL,
      supabaseURL,
    };
  }

  return {
    anonKey,
    configurationIssue: null,
    isConfigured: true,
    redirectURL,
    supabaseURL,
  };
}

export const supabaseAuthConfig = resolveSupabaseAuthConfig();

export const supabase = supabaseAuthConfig.isConfigured
  ? createClient(supabaseAuthConfig.supabaseURL, supabaseAuthConfig.anonKey, {
      auth: {
        ...(Platform.OS !== 'web' ? { storage: secureStoreAdapter } : {}),
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    })
  : null;

if (supabase && Platform.OS !== 'web' && !hasRegisteredAutoRefreshListener) {
  hasRegisteredAutoRefreshListener = true;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
