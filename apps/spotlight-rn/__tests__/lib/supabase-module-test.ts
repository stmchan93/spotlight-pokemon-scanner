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
  }: {
    os?: string;
    configured?: boolean;
    secureStoreAvailable?: boolean;
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
    const secureStore = {
      deleteItemAsync: jest.fn(async () => {}),
      getItemAsync: jest.fn(async () => 'persisted-value'),
      setItemAsync: jest.fn(async () => {}),
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
    jest.doMock('@/lib/runtime-config', () => ({
      resolveExpoScheme: jest.fn(() => 'spotlight'),
      resolveRuntimeValue: jest.fn((envKeys: string[], _extraKeys: string[]) => {
        for (const envKey of envKeys) {
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
    jest.doMock('expo-web-browser', () => ({
      maybeCompleteAuthSession,
    }));

    let moduleExports: typeof import('@/lib/supabase');
    jest.isolateModules(() => {
      moduleExports = require('@/lib/supabase');
    });

    return {
      ...moduleExports!,
      addEventListener,
      appStateListener,
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

    const createClientCall = moduleExports.createClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { storage: any } },
    ];
    const authStorage = createClientCall[2].auth.storage;
    await authStorage.setItem('session', 'token');
    await authStorage.getItem('session');
    await authStorage.removeItem('session');

    expect(moduleExports.secureStore.setItemAsync).toHaveBeenCalledWith('session', 'token');
    expect(moduleExports.secureStore.getItemAsync).toHaveBeenCalledWith('session');
    expect(moduleExports.secureStore.deleteItemAsync).toHaveBeenCalledWith('session');

    await moduleExports.appStateListener('active');
    await moduleExports.appStateListener('background');

    expect(moduleExports.startAutoRefresh).toHaveBeenCalledTimes(1);
    expect(moduleExports.stopAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to memory storage when secure store is unavailable', async () => {
    const moduleExports = loadSupabaseModule({
      secureStoreAvailable: false,
    });

    const createClientCall = moduleExports.createClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { storage: any } },
    ];
    const authStorage = createClientCall[2].auth.storage;
    await authStorage.setItem('session', 'memory-token');
    await expect(authStorage.getItem('session')).resolves.toBe('memory-token');
    await authStorage.removeItem('session');
    await expect(authStorage.getItem('session')).resolves.toBeNull();
  });

  it('falls back to memory storage when secure store rejects because keychain entitlements are missing', async () => {
    const moduleExports = loadSupabaseModule();
    const entitlementError = Object.assign(
      new Error("Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: A required entitlement isn't present."),
      { code: 'ERR_KEY_CHAIN' },
    );
    moduleExports.secureStore.getItemAsync.mockRejectedValue(entitlementError);
    moduleExports.secureStore.setItemAsync.mockRejectedValue(entitlementError);
    moduleExports.secureStore.deleteItemAsync.mockRejectedValue(entitlementError);

    const createClientCall = moduleExports.createClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { storage: any } },
    ];
    const authStorage = createClientCall[2].auth.storage;

    await expect(authStorage.getItem('session')).resolves.toBeNull();
    await authStorage.setItem('session', 'memory-token');
    await expect(authStorage.getItem('session')).resolves.toBe('memory-token');
    await authStorage.removeItem('session');
    await expect(authStorage.getItem('session')).resolves.toBeNull();

    expect(moduleExports.secureStore.getItemAsync).toHaveBeenCalledTimes(1);
    expect(moduleExports.secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(moduleExports.secureStore.deleteItemAsync).not.toHaveBeenCalled();
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
