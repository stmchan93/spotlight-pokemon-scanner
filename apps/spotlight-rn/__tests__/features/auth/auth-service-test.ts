// In-memory AsyncStorage shared by every module instance in this file. Because
// `loadAuthService` calls `jest.resetModules()`, the JS module registry is
// rebuilt between loads while this Map survives — which is exactly the
// cold-start model the anonymous-identity churn metric has to reason about.
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStore.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      mockStore.delete(key);
      return Promise.resolve();
    }),
  },
}));

type SupabaseMock = {
  auth: {
    exchangeCodeForSession: jest.Mock;
    getSession: jest.Mock;
    linkIdentity: jest.Mock;
    setSession: jest.Mock;
    signInAnonymously: jest.Mock;
    signInWithIdToken: jest.Mock;
    signInWithOAuth: jest.Mock;
    signOut: jest.Mock;
    updateUser: jest.Mock;
    verifyOtp: jest.Mock;
  };
  from: jest.Mock;
};

type LoadOptions = {
  appleModule?: Record<string, unknown>;
  capturePostHogEvent?: jest.Mock;
  config?: Record<string, unknown>;
  secureStoreFallbackState?: {
    errorCode: string | null;
    isUsingFallbackStorage: boolean;
    reason: string | null;
  };
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
      linkIdentity: jest.fn(),
      setSession: jest.fn(),
      signInAnonymously: jest.fn(),
      signInWithIdToken: jest.fn(),
      signInWithOAuth: jest.fn(),
      signOut: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
      verifyOtp: jest.fn(),
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

  const capturePostHogEvent = options.capturePostHogEvent ?? jest.fn();
  const secureStoreFallbackState = options.secureStoreFallbackState ?? {
    errorCode: null,
    isUsingFallbackStorage: false,
    reason: null,
  };

  jest.doMock('@/lib/supabase', () => ({
    getSecureStoreFallbackState: jest.fn(() => secureStoreFallbackState),
    supabase,
    supabaseAuthConfig: {
      ...defaultConfig,
      ...(options.config ?? {}),
    },
  }));
  jest.doMock('@/lib/observability/posthog', () => ({
    capturePostHogEvent,
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
    capturePostHogEvent,
    openAuthSessionAsync,
    openURL,
    service,
    supabase,
    webBrowserModule,
  };
}

/**
 * Social profile fields (Phase 2a). Every profile the service returns carries
 * them, and none of the rows in these tests set any — so this is what they fall
 * back to when the column is absent or null. Spread into the expectations so a
 * NEW field showing up fails one shared line instead of five scattered ones.
 */
const SOCIAL_PROFILE_DEFAULTS = {
  handle: null,
  bio: null,
  location: null,
  socialLink: null,
  isVerified: false,
  reputation: 0,
  followerCount: 0,
  followingCount: 0,
  postCount: 0,
};

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
      ...SOCIAL_PROFILE_DEFAULTS,
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
      // An upsert only writes name + avatar; the social fields keep their
      // defaults rather than being cleared on the returned profile.
      ...SOCIAL_PROFILE_DEFAULTS,
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
      ...SOCIAL_PROFILE_DEFAULTS,
    });
    expect(warnSpy).toHaveBeenCalledWith('[AUTH] Failed to upsert user profile.', expect.any(Error));

    const unavailable = await loadAuthService({ supabase: null });
    await expect(unavailable.service.upsertProfile('user-3', 'Local Name', null)).resolves.toEqual({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Local Name',
      labelerEnabled: false,
      userID: 'user-3',
      ...SOCIAL_PROFILE_DEFAULTS,
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
      // Carried onto the resolved AppUser, not just the UserProfile.
      ...SOCIAL_PROFILE_DEFAULTS,
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

// Converting a guest with signUp() would mint a SECOND auth user: the Python
// backend's `owner_user_id` IS the Supabase uuid, so every scan the guest made
// would stay attached to a user nobody can sign in as — and Supabase would bill
// two Monthly Active Users for one human. These helpers keep the uuid.
describe('auth-service guest conversion', () => {
  function anonymousSession() {
    return {
      access_token: 'anon-token',
      refresh_token: 'anon-refresh',
      user: {
        email: null,
        id: 'guest-1',
        identities: [],
        is_anonymous: true,
        user_metadata: {},
      },
    };
  }

  it('attaches the email to the EXISTING anonymous user and asks for a code', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: { session: anonymousSession() },
      error: null,
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.convertAnonymousUserToEmailAccount({
      email: '  new@example.com ',
      fullName: 'New Trainer',
    })).resolves.toEqual({ needsCode: true });

    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: { display_name: 'New Trainer' },
      email: 'new@example.com',
    });
  });

  it('verifies the email_change code, sets the password, and keeps the SAME uuid', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: { session: anonymousSession() },
      error: null,
    });
    supabase.auth.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'converted-token',
          user: {
            email: 'new@example.com',
            // Same id as the guest — the whole point of this path.
            id: 'guest-1',
            identities: [{ provider: 'email' }],
            is_anonymous: false,
            user_metadata: {},
          },
        },
      },
      error: null,
    });
    const upsert = upsertTableResult({ data: null, error: null });
    supabase.from.mockReturnValue(upsert.table);

    const { service } = await loadAuthService({ supabase });

    const session = await service.verifyAnonymousEmailConversion({
      code: ' 123456 ',
      email: 'new@example.com',
      fullName: 'New Trainer',
      password: 'hunter2hunter2',
    });

    // `signup`, not `email_change`, would be wrong: the user already exists.
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'new@example.com',
      token: '123456',
      type: 'email_change',
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(session.user.id).toBe('guest-1');
  });

  it('links an OAuth identity to the current anonymous user rather than signing in fresh', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: { session: anonymousSession() },
      error: null,
    });
    supabase.auth.linkIdentity.mockResolvedValue({
      data: { url: 'https://supabase.test/link' },
      error: null,
    });
    supabase.auth.setSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'linked-token',
          user: { id: 'guest-1', identities: [], is_anonymous: false, user_metadata: {} },
        },
      },
      error: null,
    });
    const openAuthSessionAsync = jest.fn().mockResolvedValue({
      type: 'success',
      url: 'spotlight://login-callback#access_token=linked-token&refresh_token=linked-refresh',
    });

    const { service } = await loadAuthService({
      supabase,
      webBrowserModule: { openAuthSessionAsync },
    });

    const session = await service.linkOAuthIdentityToCurrentUser('google');

    expect(supabase.auth.linkIdentity).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'spotlight://login-callback',
        skipBrowserRedirect: true,
      },
    });
    expect(supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(session?.user.id).toBe('guest-1');
  });

  // The guards are what make it safe to call these from the shared login flow:
  // a stray call on a REAL account must never mutate its email or password.
  it('refuses to run against a real account or with no session at all', async () => {
    const realSupabase = makeSupabaseMock();
    realSupabase.auth.getSession.mockResolvedValue({
      data: { session: makeSession() },
      error: null,
    });
    const real = await loadAuthService({ supabase: realSupabase });

    await expect(real.service.convertAnonymousUserToEmailAccount({ email: 'a@b.test' }))
      .rejects.toThrow('This session is already a real account.');
    await expect(real.service.verifyAnonymousEmailConversion({
      code: '123456',
      email: 'a@b.test',
      password: 'hunter2hunter2',
    })).rejects.toThrow('This session is already a real account.');
    await expect(real.service.linkOAuthIdentityToCurrentUser('google'))
      .rejects.toThrow('This session is already a real account.');
    expect(realSupabase.auth.updateUser).not.toHaveBeenCalled();
    expect(realSupabase.auth.linkIdentity).not.toHaveBeenCalled();

    const emptySupabase = makeSupabaseMock();
    emptySupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const empty = await loadAuthService({ supabase: emptySupabase });

    await expect(empty.service.convertAnonymousUserToEmailAccount({ email: 'a@b.test' }))
      .rejects.toThrow('There is no guest session to convert.');
  });
});

// Supabase bills per Monthly Active User, so an install is meant to mint exactly
// ONE anonymous user. A device that loses its stored session mints a brand new
// uuid instead: another billable MAU, another orphaned `owner_user_id` on the
// backend, another phantom person in PostHog. These tests pin the metric that
// tells the two apart — and, just as importantly, pin the cases that must NOT be
// reported as churn.
describe('auth-service anonymous-identity churn metric', () => {
  const LAST_USER_ID_KEY = '@spotlight/auth/anonymous-identity/last-user-id';
  const MINT_COUNT_KEY = '@spotlight/auth/anonymous-identity/mint-count';
  const RELEASED_KEY = '@spotlight/auth/anonymous-identity/released';
  const MINTED_EVENT = 'auth_anonymous_identity_minted';

  beforeEach(() => {
    mockStore.clear();
  });

  function anonymousSignInResult(userID: string) {
    return {
      data: {
        session: {
          access_token: `${userID}-token`,
          refresh_token: `${userID}-refresh`,
          user: {
            email: null,
            id: userID,
            identities: [],
            is_anonymous: true,
            user_metadata: {},
          },
        },
      },
      error: null,
    };
  }

  async function mintAnonymousUser(userID: string, options: LoadOptions = {}) {
    const supabase = options.supabase ?? makeSupabaseMock();
    supabase.auth.signInAnonymously.mockResolvedValue(anonymousSignInResult(userID));

    const loaded = await loadAuthService({ ...options, supabase });
    const session = await loaded.service.signInAnonymously();

    return { ...loaded, session };
  }

  function mintedEvents(capturePostHogEvent: jest.Mock) {
    return capturePostHogEvent.mock.calls.filter(([event]) => event === MINTED_EVENT);
  }

  it('reports the FIRST mint on an install as first_ever, never as churn', async () => {
    const { capturePostHogEvent, session } = await mintAnonymousUser('anon-1');

    expect(session.user.id).toBe('anon-1');
    expect(capturePostHogEvent).toHaveBeenCalledWith(MINTED_EVENT, {
      is_churn: false,
      mint_count: 1,
      mint_kind: 'first_ever',
      previous_anonymous_user_id: null,
      secure_store_fallback_engaged: false,
      secure_store_fallback_reason: null,
    });

    // The identity is remembered so the NEXT mint can be recognised as churn.
    expect(mockStore.get(LAST_USER_ID_KEY)).toBe('anon-1');
    expect(mockStore.get(MINT_COUNT_KEY)).toBe('1');
  });

  // The expensive case: the stored session was LOST, so this device silently
  // becomes a second billable user.
  it('reports a second, DIFFERENT uuid as churn with the running mint count', async () => {
    await mintAnonymousUser('anon-1');

    const capturePostHogEvent = jest.fn();
    await mintAnonymousUser('anon-2', {
      capturePostHogEvent,
      // Correlating churn with a broken keychain is the diagnosis we want.
      secureStoreFallbackState: {
        errorCode: 'ERR_KEY_CHAIN',
        isUsingFallbackStorage: true,
        reason: 'read_failed',
      },
    });

    expect(capturePostHogEvent).toHaveBeenCalledWith(MINTED_EVENT, {
      is_churn: true,
      mint_count: 2,
      mint_kind: 'churn',
      previous_anonymous_user_id: 'anon-1',
      secure_store_fallback_engaged: true,
      secure_store_fallback_reason: 'read_failed',
    });
    expect(mockStore.get(LAST_USER_ID_KEY)).toBe('anon-2');
    expect(mockStore.get(MINT_COUNT_KEY)).toBe('2');
  });

  // A guest who signs up KEEPS their uuid (that is the whole point of the
  // conversion helpers), so a conversion mints nothing at all — and the real
  // login the provider then records must not make a later guest mint look like a
  // lost identity.
  it('does NOT report churn for a guest → real-account conversion', async () => {
    await mintAnonymousUser('anon-1');

    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'anon-1-token',
          user: { email: null, id: 'anon-1', identities: [], is_anonymous: true, user_metadata: {} },
        },
      },
      error: null,
    });
    supabase.auth.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'converted-token',
          // Same uuid — the conversion promotes the guest in place.
          user: {
            email: 'new@example.com',
            id: 'anon-1',
            identities: [{ provider: 'email' }],
            is_anonymous: false,
            user_metadata: {},
          },
        },
      },
      error: null,
    });
    supabase.from.mockReturnValue(upsertTableResult({ data: null, error: null }).table);

    const capturePostHogEvent = jest.fn();
    const { service } = await loadAuthService({ capturePostHogEvent, supabase });

    const converted = await service.verifyAnonymousEmailConversion({
      code: '123456',
      email: 'new@example.com',
      fullName: 'New Trainer',
      password: 'hunter2hunter2',
    });

    expect(converted.user.id).toBe('anon-1');
    // Nothing was minted, so nothing is reported.
    expect(mintedEvents(capturePostHogEvent)).toHaveLength(0);

    // The provider flips this flag for every non-anonymous session it observes,
    // which is what a conversion produces. Required lazily so the AsyncStorage
    // mock factory is not evaluated before `mockStore` is initialised.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { markHasSignedIn } = require('@/features/auth/guest-first-launch') as typeof import('@/features/auth/guest-first-launch');
    await markHasSignedIn();

    const later = jest.fn();
    await mintAnonymousUser('anon-2', { capturePostHogEvent: later });

    expect(later).toHaveBeenCalledWith(MINTED_EVENT, expect.objectContaining({
      is_churn: false,
      mint_kind: 'after_account_upgrade',
    }));
  });

  // Signing out gives the identity up on purpose; it was not lost.
  it('does NOT report churn after a deliberate sign-out', async () => {
    const first = await mintAnonymousUser('anon-1');
    await first.service.signOut();
    expect(mockStore.get(RELEASED_KEY)).toBe('true');

    const capturePostHogEvent = jest.fn();
    await mintAnonymousUser('anon-2', { capturePostHogEvent });

    expect(capturePostHogEvent).toHaveBeenCalledWith(MINTED_EVENT, expect.objectContaining({
      is_churn: false,
      mint_count: 2,
      mint_kind: 'after_sign_out',
      previous_anonymous_user_id: 'anon-1',
    }));
    // Consumed: the identity minted after the sign-out is live again, so losing
    // IT must still be reported as churn.
    expect(mockStore.has(RELEASED_KEY)).toBe(false);
  });

  it('still mints the session when analytics throws', async () => {
    const capturePostHogEvent = jest.fn(() => {
      throw new Error('posthog exploded');
    });

    const { session } = await mintAnonymousUser('anon-1', { capturePostHogEvent });

    expect(session.access_token).toBe('anon-1-token');
    expect(capturePostHogEvent).toHaveBeenCalled();
    // The mint was still recorded, so the metric survives a broken analytics tier.
    expect(mockStore.get(LAST_USER_ID_KEY)).toBe('anon-1');
  });

  it('throws anonymous sign-in failures through untouched and records nothing', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInAnonymously.mockResolvedValue({
      data: { session: null },
      error: new Error('Anonymous sign-ins are disabled'),
    });

    const { capturePostHogEvent, service } = await loadAuthService({ supabase });

    await expect(service.signInAnonymously()).rejects.toThrow('Anonymous sign-ins are disabled');
    expect(mintedEvents(capturePostHogEvent)).toHaveLength(0);
    expect(mockStore.has(LAST_USER_ID_KEY)).toBe(false);
  });
});
