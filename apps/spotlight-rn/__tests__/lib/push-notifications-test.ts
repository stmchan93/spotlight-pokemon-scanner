describe('push-notifications', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    jest.resetModules();
    jest.unmock('expo-notifications');
    jest.unmock('expo-constants');
    process.env.NODE_ENV = originalNodeEnv;
  });

  function mockExpoConstants(extra: Record<string, unknown> = {}) {
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: {
        expoConfig: {
          extra,
        },
      },
    }));
  }

  function loadModule() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/push-notifications') as typeof import('@/lib/push-notifications');
  }

  it('resolves the Expo push token when permission is already granted', async () => {
    const getPermissionsAsync = jest.fn(async () => ({ status: 'granted', granted: true }));
    const requestPermissionsAsync = jest.fn(async () => ({ status: 'granted', granted: true }));
    const getExpoPushTokenAsync = jest.fn(async () => ({ data: 'ExponentPushToken[abc]' }));

    jest.doMock('expo-notifications', () => ({
      getPermissionsAsync,
      requestPermissionsAsync,
      getExpoPushTokenAsync,
      setNotificationChannelAsync: jest.fn(),
      AndroidImportance: { DEFAULT: 3 },
    }));
    mockExpoConstants({ eas: { projectId: 'looty-test-project' } });

    let result;
    let module: ReturnType<typeof loadModule>;
    jest.isolateModules(() => {
      module = loadModule();
    });
    result = await module!.registerForPushNotifications();

    expect(result.status).toBe('granted');
    expect(result.token).toBe('ExponentPushToken[abc]');
    expect(getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'looty-test-project' });
  });

  it('requests permission when undetermined and returns null token when denied', async () => {
    const getPermissionsAsync = jest.fn(async () => ({ status: 'undetermined' }));
    const requestPermissionsAsync = jest.fn(async () => ({ status: 'denied', granted: false }));
    const getExpoPushTokenAsync = jest.fn();

    jest.doMock('expo-notifications', () => ({
      getPermissionsAsync,
      requestPermissionsAsync,
      getExpoPushTokenAsync,
      setNotificationChannelAsync: jest.fn(),
      AndroidImportance: { DEFAULT: 3 },
    }));
    mockExpoConstants({});

    let module: ReturnType<typeof loadModule>;
    jest.isolateModules(() => {
      module = loadModule();
    });
    const result = await module!.registerForPushNotifications();

    expect(getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(result).toEqual({ token: null, status: 'denied' });
  });

  it('returns a null token gracefully on simulator-style failures', async () => {
    const getPermissionsAsync = jest.fn(async () => ({ status: 'granted', granted: true }));
    const getExpoPushTokenAsync = jest.fn(async () => {
      throw new Error('must be a physical device');
    });

    jest.doMock('expo-notifications', () => ({
      getPermissionsAsync,
      requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true })),
      getExpoPushTokenAsync,
      setNotificationChannelAsync: jest.fn(),
      AndroidImportance: { DEFAULT: 3 },
    }));
    mockExpoConstants({});

    let module: ReturnType<typeof loadModule>;
    jest.isolateModules(() => {
      module = loadModule();
    });
    const result = await module!.registerForPushNotifications();

    expect(result.status).toBe('granted');
    expect(result.token).toBeNull();
  });

  it('returns a null token when expo-notifications is not installed', async () => {
    jest.doMock('expo-notifications', () => {
      throw new Error('module not installed');
    });
    mockExpoConstants({});

    let module: ReturnType<typeof loadModule>;
    jest.isolateModules(() => {
      module = loadModule();
    });
    const result = await module!.registerForPushNotifications();

    expect(result).toEqual({ token: null, status: 'undetermined' });
  });
});
