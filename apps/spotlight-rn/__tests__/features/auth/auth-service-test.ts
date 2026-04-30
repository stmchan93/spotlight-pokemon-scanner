type SupabaseMock = {
  auth: {
    exchangeCodeForSession: jest.Mock;
    getSession: jest.Mock;
    setSession: jest.Mock;
    signInWithIdToken: jest.Mock;
    signInWithOAuth: jest.Mock;
    signOut: jest.Mock;
    updateUser: jest.Mock;
  };
  from: jest.Mock;
};

type LoadOptions = {
  appleModule?: Record<string, unknown>;
  config?: Record<string, unknown>;
  supabase?: SupabaseMock | null;
  webBrowserModule?: Record<string, unknown>;
};

const defaultConfig = {
  configurationIssue: null,
  isConfigured: true,
  redirectURL: 'spotlight://login-callback',
};

afterEach(() => {
  jest.useRealTimers();
});

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    user: {
      email: 'collector@example.com',
      id: 'user-1',
      identities: [
        { provider: 'google' },
        { provider: 'google' },
        { provider: 'apple' },
      ],
      user_metadata: {
        avatar_url: 'https://example.com/avatar.png',
        full_name: 'Fallback Collector',
      },
    },
    ...overrides,
  };
}

function makeSupabaseMock(): SupabaseMock {
  return {
    auth: {
      exchangeCodeForSession: jest.fn(),
      getSession: jest.fn(),
      setSession: jest.fn(),
      signInWithIdToken: jest.fn(),
      signInWithOAuth: jest.fn(),
      signOut: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: jest.fn(),
  };
}

function profileTableResult(result: unknown) {
  const single = jest.fn().mockResolvedValue(result);
  const eq = jest.fn(() => ({ single }));
  const select = jest.fn(() => ({ eq }));

  return {
    eq,
    select,
    single,
    table: { select },
  };
}

function upsertTableResult(result: unknown) {
  const single = jest.fn().mockResolvedValue(result);
  const select = jest.fn(() => ({ single }));
  const upsert = jest.fn(() => ({ select }));

  return {
    select,
    single,
    table: { upsert },
    upsert,
  };
}

async function loadAuthService(options: LoadOptions = {}) {
  jest.resetModules();

  const supabase = options.supabase === undefined ? makeSupabaseMock() : options.supabase;
  const openURL = jest.fn().mockResolvedValue(undefined);
  const openAuthSessionAsync = jest.fn();
  const webBrowserModule = options.webBrowserModule ?? {
    openAuthSessionAsync,
  };
  const appleModule = options.appleModule ?? {
    AppleAuthenticationScope: {
      EMAIL: 'EMAIL',
      FULL_NAME: 'FULL_NAME',
    },
    isAvailableAsync: jest.fn().mockResolvedValue(true),
    signInAsync: jest.fn(),
  };

  jest.doMock('@/lib/supabase', () => ({
    supabase,
    supabaseAuthConfig: {
      ...defaultConfig,
      ...(options.config ?? {}),
    },
  }));
  jest.doMock('expo-linking', () => ({
    openURL,
  }));
  jest.doMock('expo-web-browser', () => webBrowserModule);
  jest.doMock('expo-apple-authentication', () => appleModule);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require('@/features/auth/auth-service');

  return {
    appleModule,
    openAuthSessionAsync,
    openURL,
    service,
    supabase,
    webBrowserModule,
  };
}

describe('auth-service profiles', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches and maps a stored profile', async () => {
    const supabase = makeSupabaseMock();
    const table = profileTableResult({
      data: {
        admin_enabled: false,
        avatar_url: 'https://example.com/me.png',
        display_name: 'Table Vendor',
        labeler_enabled: true,
        user_id: 'user-1',
      },
      error: null,
    });
    supabase.from.mockReturnValue(table.table);

    const { service } = await loadAuthService({ supabase });

    await expect(service.fetchProfile('user-1')).resolves.toEqual({
      adminEnabled: false,
      avatarURL: 'https://example.com/me.png',
      displayName: 'Table Vendor',
      labelerEnabled: true,
      userID: 'user-1',
    });
    expect(supabase.from).toHaveBeenCalledWith('user_profiles');
    expect(table.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns null when profile fetch fails or Supabase is unavailable', async () => {
    const supabase = makeSupabaseMock();
    supabase.from.mockImplementation(() => {
      throw new Error('network failed');
    });

    const loaded = await loadAuthService({ supabase });
    await expect(loaded.service.fetchProfile('user-1')).resolves.toBeNull();

    const unavailable = await loadAuthService({ supabase: null });
    await expect(unavailable.service.fetchProfile('user-1')).resolves.toBeNull();
  });

  it('upserts profiles, syncs auth metadata, and falls back when persistence fails', async () => {
    const supabase = makeSupabaseMock();
    const table = upsertTableResult({
      data: {
        avatar_url: 'https://example.com/fresh.png',
        display_name: 'Fresh Name',
        user_id: 'user-1',
      },
      error: null,
    });
    supabase.from.mockReturnValue(table.table);

    const { service } = await loadAuthService({ supabase });

    await expect(service.upsertProfile('user-1', '  Fresh Name  ', 'https://example.com/fresh.png')).resolves.toEqual({
      adminEnabled: false,
      avatarURL: 'https://example.com/fresh.png',
      displayName: 'Fresh Name',
      labelerEnabled: false,
      userID: 'user-1',
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: {
        avatar_url: 'https://example.com/fresh.png',
        display_name: 'Fresh Name',
      },
    });
    expect(table.upsert).toHaveBeenCalledWith({
      avatar_url: 'https://example.com/fresh.png',
      display_name: 'Fresh Name',
      user_id: 'user-1',
    }, {
      onConflict: 'user_id',
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    supabase.auth.updateUser.mockRejectedValueOnce(new Error('metadata failed'));
    await expect(service.upsertProfile('user-2', 'Backup Name', null)).resolves.toEqual({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Backup Name',
      labelerEnabled: false,
      userID: 'user-2',
    });
    expect(warnSpy).toHaveBeenCalledWith('[AUTH] Failed to upsert user profile.', expect.any(Error));

    const unavailable = await loadAuthService({ supabase: null });
    await expect(unavailable.service.upsertProfile('user-3', 'Local Name', null)).resolves.toEqual({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Local Name',
      labelerEnabled: false,
      userID: 'user-3',
    });
  });

  it('resolves app users from profile data and metadata fallbacks', async () => {
    jest.useFakeTimers();

    const supabase = makeSupabaseMock();
    const table = profileTableResult({
      data: {
        admin_enabled: true,
        avatar_url: 'https://example.com/profile.png',
        display_name: 'Profile Name',
        labeler_enabled: true,
        user_id: 'user-1',
      },
      error: null,
    });
    supabase.from.mockReturnValue(table.table);

    const { service } = await loadAuthService({ supabase });

    await expect(service.resolveAppUserFromSession(makeSession())).resolves.toEqual({
      adminEnabled: true,
      avatarURL: 'https://example.com/profile.png',
      displayName: 'Profile Name',
      email: 'collector@example.com',
      id: 'user-1',
      labelerEnabled: true,
      providers: ['google', 'apple'],
    });

    table.single
      .mockResolvedValueOnce({ data: null, error: new Error('missing') })
      .mockResolvedValueOnce({ data: null, error: new Error('missing') });
    await expect(service.resolveAppUserFromSession(makeSession())).resolves.toMatchObject({
      adminEnabled: false,
      avatarURL: 'https://example.com/avatar.png',
      displayName: 'Fallback Collector',
      labelerEnabled: false,
    });
  });
});

describe('auth-service callback restore', () => {
  it('restores access-token callbacks, auth-code callbacks, errors, and no-op URLs', async () => {
    const supabase = makeSupabaseMock();
    const tokenSession = makeSession({ access_token: 'token-session' });
    const codeSession = makeSession({ access_token: 'code-session' });
    supabase.auth.setSession.mockResolvedValue({
      data: { session: tokenSession },
      error: null,
    });
    supabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: codeSession },
      error: null,
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.restoreSessionFromUrl('spotlight://login#access_token=access&refresh_token=refresh')).resolves.toBe(tokenSession);
    expect(supabase.auth.setSession).toHaveBeenCalledWith({
      access_token: 'access',
      refresh_token: 'refresh',
    });

    await expect(service.restoreSessionFromUrl('spotlight://login?code=auth-code')).resolves.toBe(codeSession);
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('auth-code');

    await expect(service.restoreSessionFromUrl('spotlight://login?error_code=access_denied&error_description=Denied')).rejects.toThrow('Denied');
    await expect(service.restoreSessionFromUrl('spotlight://login?state=ignored')).resolves.toBeNull();
  });

  it('throws Supabase restore errors and no-ops when auth is unavailable', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: new Error('bad token'),
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.restoreSessionFromUrl('spotlight://login?access_token=access&refresh_token=refresh')).rejects.toThrow('bad token');

    const unavailable = await loadAuthService({ supabase: null });
    await expect(unavailable.service.restoreSessionFromUrl('spotlight://login?code=auth-code')).resolves.toBeNull();
  });
});

describe('auth-service Google sign-in', () => {
  it('handles cancel, opened fallback, successful callback restore, missing URL, and provider errors', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://auth.example.com/google' },
      error: null,
    });
    supabase.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: makeSession() },
      error: null,
    });

    const { openAuthSessionAsync, openURL, service } = await loadAuthService({ supabase });

    openAuthSessionAsync.mockResolvedValueOnce({ type: 'cancel' });
    await expect(service.signInWithGoogle()).rejects.toThrow(service.AuthCanceledError);

    openAuthSessionAsync.mockResolvedValueOnce({ type: 'opened' });
    await expect(service.signInWithGoogle()).resolves.toBeNull();
    expect(openURL).toHaveBeenCalledWith('https://auth.example.com/google');

    openAuthSessionAsync.mockResolvedValueOnce({
      type: 'success',
      url: 'spotlight://login?code=auth-code',
    });
    await expect(service.signInWithGoogle()).resolves.toMatchObject({
      access_token: 'access-token',
    });

    supabase.auth.signInWithOAuth.mockResolvedValueOnce({
      data: { url: '' },
      error: null,
    });
    await expect(service.signInWithGoogle()).rejects.toThrow('Google sign-in could not be started.');

    supabase.auth.signInWithOAuth.mockResolvedValueOnce({
      data: null,
      error: new Error('provider failed'),
    });
    await expect(service.signInWithGoogle()).rejects.toThrow('provider failed');

    supabase.auth.signInWithOAuth.mockResolvedValueOnce({
      data: { url: 'https://auth.example.com/google' },
      error: null,
    });
    openAuthSessionAsync.mockResolvedValueOnce({ type: 'locked' });
    await expect(service.signInWithGoogle()).rejects.toThrow('Google sign-in could not be completed.');
  });

  it('reports configuration errors when Supabase is unavailable', async () => {
    const { service } = await loadAuthService({
      config: {
        configurationIssue: 'Missing Supabase URL.',
      },
      supabase: null,
    });

    await expect(service.signInWithGoogle()).rejects.toThrow('Missing Supabase URL.');
  });
});

describe('auth-service Apple sign-in', () => {
  it('handles availability, success, missing token, missing session, and cancel errors', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({
      data: { session: makeSession() },
      error: null,
    });
    const table = upsertTableResult({
      data: {
        avatar_url: null,
        display_name: 'Apple Collector',
        user_id: 'user-1',
      },
      error: null,
    });
    supabase.from.mockReturnValue(table.table);

    const appleModule = {
      AppleAuthenticationScope: {
        EMAIL: 'EMAIL',
        FULL_NAME: 'FULL_NAME',
      },
      isAvailableAsync: jest.fn().mockResolvedValue(true),
      signInAsync: jest.fn().mockResolvedValue({
        authorizationCode: 'apple-code',
        fullName: {
          familyName: 'Collector',
          givenName: 'Apple',
        },
        identityToken: 'identity-token',
      }),
    };

    const { service } = await loadAuthService({ appleModule, supabase });

    await expect(service.checkAppleSignInAvailability()).resolves.toBe(true);
    await expect(service.signInWithApple()).resolves.toMatchObject({
      access_token: 'access-token',
    });
    expect(supabase.auth.signInWithIdToken).toHaveBeenCalledWith({
      access_token: 'apple-code',
      nonce: expect.any(String),
      provider: 'apple',
      token: 'identity-token',
    });
    expect(table.upsert).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'Apple Collector',
      user_id: 'user-1',
    }), {
      onConflict: 'user_id',
    });

    appleModule.signInAsync.mockResolvedValueOnce({
      fullName: null,
      identityToken: null,
    });
    await expect(service.signInWithApple()).rejects.toThrow('Apple sign-in did not return a valid identity token.');

    appleModule.signInAsync.mockResolvedValueOnce({
      fullName: null,
      identityToken: 'identity-token',
    });
    supabase.auth.signInWithIdToken.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    await expect(service.signInWithApple()).rejects.toThrow('Apple sign-in did not create a session.');

    appleModule.signInAsync.mockRejectedValueOnce({ code: 'ERR_REQUEST_CANCELED' });
    await expect(service.signInWithApple()).rejects.toThrow(service.AuthCanceledError);
  });

  it('returns false when Apple availability cannot be checked', async () => {
    const { service } = await loadAuthService({
      appleModule: {
        AppleAuthenticationScope: {
          EMAIL: 'EMAIL',
          FULL_NAME: 'FULL_NAME',
        },
        isAvailableAsync: jest.fn().mockRejectedValue(new Error('unavailable')),
        signInAsync: jest.fn(),
      },
    });

    await expect(service.checkAppleSignInAvailability()).resolves.toBe(false);
  });
});

describe('auth-service session helpers', () => {
  it('gets the current session, signs out, and exposes helper state', async () => {
    const supabase = makeSupabaseMock();
    const session = makeSession();
    supabase.auth.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    const { service } = await loadAuthService({
      config: {
        configurationIssue: 'config warning',
        isConfigured: false,
      },
      supabase,
    });

    await expect(service.getCurrentSession()).resolves.toBe(session);
    expect(service.getAccessToken(session)).toBe('access-token');
    expect(service.getAccessToken(null)).toBeNull();
    expect(service.getNeedsProfile({
      adminEnabled: false,
      avatarURL: null,
      displayName: ' ',
      email: null,
      id: 'user-1',
      labelerEnabled: false,
      providers: [],
    })).toBe(true);
    expect(service.getNeedsProfile(null)).toBe(false);
    expect(service.getConfigurationIssue()).toBe('config warning');
    expect(service.getIsConfigured()).toBe(false);

    await expect(service.signOut()).resolves.toBeUndefined();
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('throws get-session errors and no-ops session calls without Supabase', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new Error('session failed'),
    });

    const { service } = await loadAuthService({ supabase });
    await expect(service.getCurrentSession()).rejects.toThrow('session failed');

    const unavailable = await loadAuthService({ supabase: null });
    await expect(unavailable.service.getCurrentSession()).resolves.toBeNull();
    await expect(unavailable.service.signOut()).resolves.toBeUndefined();
  });
});
