// Native Google sign-in (@react-native-google-signin/google-signin) with the
// browser flow as the fallback for binaries that lack the module or config.

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));

const IOS_CLIENT_ID = '123-ios.apps.googleusercontent.com';
const WEB_CLIENT_ID = '123-web.apps.googleusercontent.com';
const IOS_URL_SCHEME = 'com.googleusercontent.apps.123-ios';

const statusCodes = {
  IN_PROGRESS: 'IN_PROGRESS',
  NULL_PRESENTER: 'NULL_PRESENTER',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
};

function makeGoogleModule() {
  return {
    GoogleSignin: {
      configure: jest.fn(),
      hasPlayServices: jest.fn().mockResolvedValue(true),
      signIn: jest.fn().mockResolvedValue({
        type: 'success',
        data: { idToken: 'google-id-token', user: { id: 'g-1', email: 'c@example.com' } },
      }),
      signOut: jest.fn().mockResolvedValue(null),
    },
    statusCodes,
  };
}

function makeSupabaseMock() {
  return {
    auth: {
      getSession: jest.fn(),
      linkIdentity: jest.fn(),
      signInWithIdToken: jest.fn(),
      signInWithOAuth: jest.fn(),
      signOut: jest.fn().mockResolvedValue({ error: null }),
    },
    from: jest.fn(),
  };
}

type LoadOptions = {
  canOpenURL?: jest.Mock;
  clientIds?: { iosClientId: string | null; webClientId: string | null };
  // null = the binary predates the dependency (the package import throws).
  googleModule?: ReturnType<typeof makeGoogleModule> | null;
  platform?: 'ios' | 'android';
  supabase?: ReturnType<typeof makeSupabaseMock>;
};

function loadAuthService(options: LoadOptions = {}) {
  jest.resetModules();

  const supabase = options.supabase ?? makeSupabaseMock();
  const googleModule = options.googleModule === undefined ? makeGoogleModule() : options.googleModule;
  const canOpenURL = options.canOpenURL
    ?? jest.fn(async (url: string) => url === `${IOS_URL_SCHEME}:/`);
  const openAuthSessionAsync = jest.fn().mockResolvedValue({ type: 'cancel' });

  jest.doMock('@/lib/supabase', () => ({
    getSecureStoreFallbackState: jest.fn(() => ({ errorCode: null, isUsingFallbackStorage: false, reason: null })),
    supabase,
    supabaseAuthConfig: {
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://login-callback',
    },
  }));
  jest.doMock('@/lib/observability/posthog', () => ({ capturePostHogEvent: jest.fn() }));
  jest.doMock('expo-linking', () => ({ canOpenURL, openURL: jest.fn() }));
  jest.doMock('expo-web-browser', () => ({ openAuthSessionAsync }));
  jest.doMock('expo-apple-authentication', () => ({}));
  jest.doMock('@/features/auth/google-sign-in-config', () => ({
    ...jest.requireActual('@/features/auth/google-sign-in-config'),
    getGoogleSignInClientIds: () => options.clientIds ?? {
      iosClientId: IOS_CLIENT_ID,
      webClientId: WEB_CLIENT_ID,
    },
  }));
  jest.doMock('@react-native-google-signin/google-signin', () => {
    if (!googleModule) {
      // What the real package does when RNGoogleSignin isn't in the binary.
      throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNGoogleSignin' could not be found.");
    }
    return googleModule;
  });

  const { Platform } = require('react-native');
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => options.platform ?? 'ios' });

  const service = require('@/features/auth/auth-service');
  return { canOpenURL, googleModule, openAuthSessionAsync, service, supabase };
}

function anonymousSession() {
  return {
    access_token: 'guest-token',
    refresh_token: 'guest-refresh',
    user: { id: 'guest-1', identities: [], is_anonymous: true, user_metadata: {} },
  };
}

describe('auth-service native Google sign-in', () => {
  it('signs in with the native id token via signInWithIdToken (iOS)', async () => {
    const supabase = makeSupabaseMock();
    const session = { access_token: 'a', user: { id: 'user-1' } };
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: { session }, error: null });
    const { googleModule, openAuthSessionAsync, service } = loadAuthService({ supabase });

    await expect(service.signInWithGoogle()).resolves.toBe(session);

    expect(googleModule!.GoogleSignin.configure).toHaveBeenCalledWith({
      webClientId: WEB_CLIENT_ID,
      iosClientId: IOS_CLIENT_ID,
    });
    expect(supabase.auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'google',
      token: 'google-id-token',
    });
    expect(supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it('checks Play services and omits iosClientId on Android', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: { session: { user: { id: 'u' } } }, error: null });
    const { canOpenURL, googleModule, service } = loadAuthService({ platform: 'android', supabase });

    await service.signInWithGoogle();

    expect(googleModule!.GoogleSignin.hasPlayServices).toHaveBeenCalled();
    expect(googleModule!.GoogleSignin.configure).toHaveBeenCalledWith({ webClientId: WEB_CLIENT_ID });
    expect(canOpenURL).not.toHaveBeenCalled();
  });

  it('links Google to the guest with linkIdentity({ token }) so the uuid survives', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({ data: { session: anonymousSession() }, error: null });
    const upgraded = {
      access_token: 'linked',
      user: { id: 'guest-1', identities: [{ provider: 'google' }], is_anonymous: false },
    };
    supabase.auth.linkIdentity.mockResolvedValue({ data: { session: upgraded }, error: null });
    const { openAuthSessionAsync, service } = loadAuthService({ supabase });

    const session = await service.linkOAuthIdentityToCurrentUser('google');

    expect(supabase.auth.linkIdentity).toHaveBeenCalledWith({ provider: 'google', token: 'google-id-token' });
    expect(session.user.id).toBe('guest-1');
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it('refuses the native link on a real account before showing the sheet', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'a', user: { id: 'user-1', is_anonymous: false } } },
      error: null,
    });
    const { googleModule, service } = loadAuthService({ supabase });

    await expect(service.linkOAuthIdentityToCurrentUser('google'))
      .rejects.toThrow('This session is already a real account.');
    expect(googleModule!.GoogleSignin.signIn).not.toHaveBeenCalled();
    expect(supabase.auth.linkIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['a cancelled response', () => ({ type: 'cancelled', data: null }), null],
    ['SIGN_IN_CANCELLED', null, 'SIGN_IN_CANCELLED'],
    ['IN_PROGRESS', null, 'IN_PROGRESS'],
  ])('maps %s to AuthCanceledError', async (_label, resolved, rejectCode) => {
    const { googleModule, service, supabase } = loadAuthService();
    if (resolved) {
      googleModule!.GoogleSignin.signIn.mockResolvedValueOnce(resolved());
    } else {
      googleModule!.GoogleSignin.signIn.mockRejectedValueOnce(Object.assign(new Error('native'), { code: rejectCode }));
    }

    await expect(service.signInWithGoogle()).rejects.toBeInstanceOf(service.AuthCanceledError);
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('carries the native error code for telemetry and a clear Play services message', async () => {
    const { googleModule, service } = loadAuthService({ platform: 'android' });

    googleModule!.GoogleSignin.signIn.mockRejectedValueOnce(Object.assign(new Error('DEVELOPER_ERROR'), { code: '10' }));
    const developerError = await service.signInWithGoogle().catch((error: unknown) => error);
    expect(developerError).toBeInstanceOf(service.GoogleNativeSignInError);
    expect(developerError).toMatchObject({ code: 'google_native:10' });

    googleModule!.GoogleSignin.hasPlayServices.mockRejectedValueOnce(
      Object.assign(new Error('no play'), { code: 'PLAY_SERVICES_NOT_AVAILABLE' }),
    );
    const playError = await service.signInWithGoogle().catch((error: unknown) => error);
    expect(playError).toMatchObject({ code: 'google_native:PLAY_SERVICES_NOT_AVAILABLE' });
    expect((playError as Error).message).toContain('Google Play services');

    googleModule!.GoogleSignin.signIn.mockResolvedValueOnce({ type: 'success', data: { idToken: null } });
    await expect(service.signInWithGoogle()).rejects.toMatchObject({ code: 'google_native:missing_id_token' });
  });

  it('signs out of the native Google session (best effort) on sign-out', async () => {
    const { googleModule, service, supabase } = loadAuthService();
    googleModule!.GoogleSignin.signOut.mockRejectedValueOnce(new Error('native boom'));

    await expect(service.signOut()).resolves.toBeUndefined();
    expect(googleModule!.GoogleSignin.signOut).toHaveBeenCalled();
    expect(supabase.auth.signOut).toHaveBeenCalled();
  });

  describe('falls back to the browser flow', () => {
    async function expectBrowserFlow(options: LoadOptions) {
      const supabase = makeSupabaseMock();
      supabase.auth.signInWithOAuth.mockResolvedValue({
        data: { url: 'https://auth.example.com/google' },
        error: null,
      });
      const loaded = loadAuthService({ ...options, supabase });

      // Browser cancel → AuthCanceledError, proving the old path ran.
      await expect(loaded.service.signInWithGoogle()).rejects.toBeInstanceOf(loaded.service.AuthCanceledError);
      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
      expect(loaded.openAuthSessionAsync).toHaveBeenCalled();
      expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
      return loaded;
    }

    it('when the binary lacks the native module (OTA on an old build)', async () => {
      await expectBrowserFlow({ googleModule: null });
    });

    it('when the client ids are not configured', async () => {
      const { googleModule } = await expectBrowserFlow({ clientIds: { iosClientId: null, webClientId: null } });
      expect(googleModule!.GoogleSignin.configure).not.toHaveBeenCalled();
    });

    it('on iOS when the binary does not register the reversed-client-id scheme', async () => {
      const { googleModule } = await expectBrowserFlow({ canOpenURL: jest.fn().mockResolvedValue(false) });
      expect(googleModule!.GoogleSignin.signIn).not.toHaveBeenCalled();
    });

    it('for guest linking when the native module is missing', async () => {
      const supabase = makeSupabaseMock();
      supabase.auth.getSession.mockResolvedValue({ data: { session: anonymousSession() }, error: null });
      supabase.auth.linkIdentity.mockResolvedValue({ data: { url: 'https://auth.example.com/link' }, error: null });
      const { openAuthSessionAsync, service } = loadAuthService({ googleModule: null, supabase });

      await expect(service.linkOAuthIdentityToCurrentUser('google')).rejects.toBeInstanceOf(service.AuthCanceledError);
      expect(supabase.auth.linkIdentity).toHaveBeenCalledWith({
        provider: 'google',
        options: { redirectTo: 'spotlight://login-callback', skipBrowserRedirect: true },
      });
      expect(openAuthSessionAsync).toHaveBeenCalled();
    });

    it('and sign-out still works without the native module', async () => {
      const { service, supabase } = loadAuthService({ googleModule: null });
      await expect(service.signOut()).resolves.toBeUndefined();
      expect(supabase.auth.signOut).toHaveBeenCalled();
    });
  });
});
