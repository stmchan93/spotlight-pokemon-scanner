// The auth-storage adapter is billing-critical: Supabase counts a monthly active
// user as anyone who signs in OR refreshes a token, so a session that does not
// survive process death mints a brand new billable identity on every cold start.
// These tests pin the tiering (keychain -> AsyncStorage -> memory) that prevents it.
const FALLBACK_ENGAGED_KEY = '@spotlight/auth/secure-store-fallback-engaged';
const FALLBACK_VALUE_KEY = '@spotlight/auth/secure-store-fallback/session';

// The keychain accessibility constant exposed by the expo-secure-store mock.
const AFTER_FIRST_UNLOCK = 1;
const SECURE_STORE_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK };

function createKeychainError() {
  return Object.assign(
    new Error("Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: A required entitlement isn't present."),
    { code: 'ERR_KEY_CHAIN' },
  );
}

describe('supabase module', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadSupabaseModule({
    os = 'ios',
    configured = true,
    secureStoreAvailable = true,
    asyncStorageAvailable = true,
    // Passing the same Map into two loads simulates a cold start: the JS module
    // state is rebuilt while device storage survives.
    asyncStorageStore = new Map<string, string>(),
  }: {
    os?: string;
    configured?: boolean;
    secureStoreAvailable?: boolean;
    asyncStorageAvailable?: boolean;
    asyncStorageStore?: Map<string, string>;
  } = {}) {
    const appStateListener = jest.fn();
    const addEventListener = jest.fn((_event, callback) => {
      appStateListener.mockImplementation(callback);
      return { remove: jest.fn() };
    });
    const startAutoRefresh = jest.fn(async () => {});
    const stopAutoRefresh = jest.fn(async () => {});
    const createClient = jest.fn(() => ({
      auth: {
        startAutoRefresh,
        stopAutoRefresh,
      },
    }));
    const maybeCompleteAuthSession = jest.fn();
    const capturePostHogEvent = jest.fn();
    const secureStore = {
      AFTER_FIRST_UNLOCK,
      deleteItemAsync: jest.fn(async () => {}),
      getItemAsync: jest.fn(async () => 'persisted-value' as string | null),
      setItemAsync: jest.fn(async () => {}),
    };
    const asyncStorage = {
      getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
      removeItem: jest.fn(async (key: string) => {
        asyncStorageStore.delete(key);
      }),
      setItem: jest.fn(async (key: string, value: string) => {
        asyncStorageStore.set(key, value);
      }),
    };

    process.env = {
      ...originalEnv,
    };

    if (configured) {
      process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL = 'https://example.supabase.co';
      process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY = 'anon-key';
    } else {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL;
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY;
    }

    jest.doMock('react-native', () => ({
      AppState: {
        addEventListener,
      },
      Platform: {
        OS: os,
      },
    }));
    jest.doMock('@supabase/supabase-js', () => ({
      createClient,
    }));
    jest.doMock('expo-auth-session', () => ({
      makeRedirectUri: jest.fn(() => 'spotlight://login-callback'),
    }));
    jest.doMock('react-native-url-polyfill/auto', () => ({}));
    jest.doMock('@/lib/observability/posthog', () => ({
      capturePostHogEvent,
    }));
    jest.doMock('@/lib/runtime-config', () => ({
      resolveExpoScheme: jest.fn(() => 'spotlight'),
      resolveRuntimeValue: jest.fn((envKeys: string[], _extraKeys: string[]) => {
        for (const envKey of envKeys) {
          // eslint-disable-next-line expo/no-dynamic-env-var
          const value = process.env[envKey];
          if (value) {
            return value;
          }
        }
        return '';
      }),
    }));
    if (secureStoreAvailable) {
      jest.doMock('expo-secure-store', () => secureStore);
    } else {
      jest.doMock('expo-secure-store', () => {
        throw new Error("Cannot find native module 'ExpoSecureStore'");
      });
    }
    if (asyncStorageAvailable) {
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        __esModule: true,
        default: asyncStorage,
      }));
    } else {
      jest.doMock('@react-native-async-storage/async-storage', () => {
        throw new Error("Cannot find native module 'RNCAsyncStorage'");
      });
    }
    jest.doMock('expo-web-browser', () => ({
      maybeCompleteAuthSession,
    }));

    let moduleExports: typeof import('@/lib/supabase');
    jest.isolateModules(() => {
      moduleExports = require('@/lib/supabase');
    });

    const createClientCall = createClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { storage?: { getItem: (key: string) => Promise<string | null>; removeItem: (key: string) => Promise<void>; setItem: (key: string, value: string) => Promise<void> } } },
    ] | undefined;

    return {
      ...moduleExports!,
      addEventListener,
      appStateListener,
      asyncStorage,
      asyncStorageStore,
      authStorage: createClientCall?.[2].auth.storage,
      capturePostHogEvent,
      createClient,
      maybeCompleteAuthSession,
      secureStore,
      startAutoRefresh,
      stopAutoRefresh,
    };
  }

  it('creates a native client with secure storage and auto-refresh wiring on iOS', async () => {
    const moduleExports = loadSupabaseModule();

    expect(moduleExports.supabaseAuthConfig.isConfigured).toBe(true);
    expect(moduleExports.supabase).not.toBeNull();
    expect(moduleExports.createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({
          autoRefreshToken: true,
          detectSessionInUrl: false,
          persistSession: true,
          storage: expect.any(Object),
        }),
      }),
    );
    expect(moduleExports.maybeCompleteAuthSession).toHaveBeenCalledTimes(1);
    expect(moduleExports.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    const authStorage = moduleExports.authStorage!;
    await authStorage.setItem('session', 'token');
    await authStorage.getItem('session');
    await authStorage.removeItem('session');

    expect(moduleExports.secureStore.setItemAsync).toHaveBeenCalledWith('session', 'token', SECURE_STORE_OPTIONS);
    expect(moduleExports.secureStore.getItemAsync).toHaveBeenCalledWith('session', SECURE_STORE_OPTIONS);
    expect(moduleExports.secureStore.deleteItemAsync).toHaveBeenCalledWith('session', SECURE_STORE_OPTIONS);

    // Healthy keychain: nothing leaks into plaintext storage, and no fallback event.
    expect(moduleExports.asyncStorage.setItem).not.toHaveBeenCalled();
    expect(moduleExports.capturePostHogEvent).not.toHaveBeenCalled();
    expect(moduleExports.getSecureStoreFallbackState().isUsingFallbackStorage).toBe(false);

    await moduleExports.appStateListener('active');
    await moduleExports.appStateListener('background');

    expect(moduleExports.startAutoRefresh).toHaveBeenCalledTimes(1);
    expect(moduleExports.stopAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('writes tokens with AFTER_FIRST_UNLOCK so a locked-device token refresh can read them', async () => {
    const moduleExports = loadSupabaseModule();

    await moduleExports.authStorage!.setItem('session', 'token');

    const [, , options] = moduleExports.secureStore.setItemAsync.mock.calls[0] as unknown as [
      string,
      string,
      { keychainAccessible?: number },
    ];
    expect(options.keychainAccessible).toBe(AFTER_FIRST_UNLOCK);
    expect(options.keychainAccessible).toBe(moduleExports.secureStore.AFTER_FIRST_UNLOCK);
  });

  it('falls back to persistent storage when secure store is unavailable', async () => {
    const moduleExports = loadSupabaseModule({
      secureStoreAvailable: false,
    });

    const authStorage = moduleExports.authStorage!;
    await authStorage.setItem('session', 'memory-token');
    await expect(authStorage.getItem('session')).resolves.toBe('memory-token');
    expect(moduleExports.asyncStorageStore.get(FALLBACK_VALUE_KEY)).toBe('memory-token');

    await authStorage.removeItem('session');
    await expect(authStorage.getItem('session')).resolves.toBeNull();
    expect(moduleExports.asyncStorageStore.has(FALLBACK_VALUE_KEY)).toBe(false);

    expect(moduleExports.capturePostHogEvent).toHaveBeenCalledWith(
      'auth_secure_store_fallback_engaged',
      expect.objectContaining({ reason: 'module_unavailable' }),
    );
  });

  it('falls back to persistent storage when secure store rejects because keychain entitlements are missing', async () => {
    const moduleExports = loadSupabaseModule();
    const entitlementError = createKeychainError();
    moduleExports.secureStore.getItemAsync.mockRejectedValue(entitlementError);
    moduleExports.secureStore.setItemAsync.mockRejectedValue(entitlementError);
    moduleExports.secureStore.deleteItemAsync.mockRejectedValue(entitlementError);

    const authStorage = moduleExports.authStorage!;

    await expect(authStorage.getItem('session')).resolves.toBeNull();
    await authStorage.setItem('session', 'fallback-token');
    await expect(authStorage.getItem('session')).resolves.toBe('fallback-token');
    await authStorage.removeItem('session');
    await expect(authStorage.getItem('session')).resolves.toBeNull();

    // The keychain is only probed until it proves unusable; afterwards every
    // operation is served by the persistent fallback tier.
    expect(moduleExports.secureStore.getItemAsync).toHaveBeenCalledTimes(1);
    expect(moduleExports.secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(moduleExports.secureStore.deleteItemAsync).not.toHaveBeenCalled();

    expect(moduleExports.capturePostHogEvent).toHaveBeenCalledTimes(1);
    expect(moduleExports.capturePostHogEvent).toHaveBeenCalledWith(
      'auth_secure_store_fallback_engaged',
      expect.objectContaining({ error_code: 'ERR_KEY_CHAIN', reason: 'read_failed' }),
    );
    expect(moduleExports.getSecureStoreFallbackState()).toEqual({
      errorCode: 'ERR_KEY_CHAIN',
      isUsingFallbackStorage: true,
      reason: 'read_failed',
    });
  });

  it('keeps the session across a cold start after the keychain fallback engages', async () => {
    // Shared device storage; the module registry is rebuilt between "launches".
    const deviceStorage = new Map<string, string>();

    const firstLaunch = loadSupabaseModule({ asyncStorageStore: deviceStorage });
    firstLaunch.secureStore.getItemAsync.mockResolvedValue(null);
    firstLaunch.secureStore.setItemAsync.mockRejectedValue(createKeychainError());

    await firstLaunch.authStorage!.setItem('session', 'refreshed-token');
    expect(deviceStorage.get(FALLBACK_VALUE_KEY)).toBe('refreshed-token');
    expect(deviceStorage.get(FALLBACK_ENGAGED_KEY)).toBe('ERR_KEY_CHAIN');

    jest.resetModules();

    const secondLaunch = loadSupabaseModule({ asyncStorageStore: deviceStorage });
    // A stale token still sits in the keychain from before the failure; handing
    // it to supabase-js would sign the user out and mint a new billable user.
    secondLaunch.secureStore.getItemAsync.mockResolvedValue('stale-keychain-token');

    await expect(secondLaunch.authStorage!.getItem('session')).resolves.toBe('refreshed-token');
    expect(secondLaunch.secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secondLaunch.getSecureStoreFallbackState()).toEqual({
      errorCode: 'ERR_KEY_CHAIN',
      isUsingFallbackStorage: true,
      reason: 'previously_engaged',
    });
  });

  it('migrates an existing secure-store session into the fallback tier on upgrade', async () => {
    // Device already flagged as keychain-broken, but the pre-existing session is
    // still readable — it must be carried over instead of dropped.
    const deviceStorage = new Map<string, string>([[FALLBACK_ENGAGED_KEY, 'ERR_KEY_CHAIN']]);
    const moduleExports = loadSupabaseModule({ asyncStorageStore: deviceStorage });
    moduleExports.secureStore.getItemAsync.mockResolvedValue('legacy-keychain-session');

    await expect(moduleExports.authStorage!.getItem('session')).resolves.toBe('legacy-keychain-session');
    expect(deviceStorage.get(FALLBACK_VALUE_KEY)).toBe('legacy-keychain-session');

    // Migration is attempted once per key, then served from the fallback tier.
    await expect(moduleExports.authStorage!.getItem('session')).resolves.toBe('legacy-keychain-session');
    expect(moduleExports.secureStore.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a migrated keychain session after sign-out', async () => {
    const deviceStorage = new Map<string, string>([[FALLBACK_ENGAGED_KEY, 'ERR_KEY_CHAIN']]);
    const moduleExports = loadSupabaseModule({ asyncStorageStore: deviceStorage });
    moduleExports.secureStore.getItemAsync.mockResolvedValue('legacy-keychain-session');
    moduleExports.secureStore.deleteItemAsync.mockRejectedValue(createKeychainError());

    const authStorage = moduleExports.authStorage!;
    await expect(authStorage.getItem('session')).resolves.toBe('legacy-keychain-session');

    await authStorage.removeItem('session');

    await expect(authStorage.getItem('session')).resolves.toBeNull();
    // Sign-out also clears the sticky marker so a recovered device can go back
    // to the keychain on its next sign-in.
    expect(deviceStorage.has(FALLBACK_ENGAGED_KEY)).toBe(false);
  });

  it('still serves the session from memory when AsyncStorage is unavailable too', async () => {
    const moduleExports = loadSupabaseModule({
      asyncStorageAvailable: false,
      secureStoreAvailable: false,
    });

    const authStorage = moduleExports.authStorage!;
    await expect(authStorage.setItem('session', 'memory-only')).resolves.toBeUndefined();
    await expect(authStorage.getItem('session')).resolves.toBe('memory-only');
    await expect(authStorage.removeItem('session')).resolves.toBeUndefined();
    await expect(authStorage.getItem('session')).resolves.toBeNull();
  });

  it('rethrows secure-store errors that are not keychain failures', async () => {
    const moduleExports = loadSupabaseModule();
    const unrelatedError = new Error('disk full');
    moduleExports.secureStore.setItemAsync.mockRejectedValue(unrelatedError);

    await expect(moduleExports.authStorage!.setItem('session', 'token')).rejects.toThrow('disk full');
    expect(moduleExports.getSecureStoreFallbackState().isUsingFallbackStorage).toBe(false);
    expect(moduleExports.asyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('skips storage wiring and app-state refresh registration on web', () => {
    const moduleExports = loadSupabaseModule({
      os: 'web',
    });

    expect(moduleExports.createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: expect.not.objectContaining({
          storage: expect.anything(),
        }),
      }),
    );
    expect(moduleExports.addEventListener).not.toHaveBeenCalled();
  });

  it('does not create a client when runtime configuration is incomplete', () => {
    const moduleExports = loadSupabaseModule({
      configured: false,
    });

    expect(moduleExports.supabaseAuthConfig.isConfigured).toBe(false);
    expect(moduleExports.supabaseAuthConfig.configurationIssue).toContain('Supabase URL is missing');
    expect(moduleExports.supabase).toBeNull();
    expect(moduleExports.createClient).not.toHaveBeenCalled();
    expect(moduleExports.addEventListener).not.toHaveBeenCalled();
  });
});
