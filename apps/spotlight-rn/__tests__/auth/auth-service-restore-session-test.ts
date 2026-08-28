type SupabaseMock = {
  auth: {
    exchangeCodeForSession: jest.Mock;
    getSession: jest.Mock;
    setSession: jest.Mock;
  };
  from: jest.Mock;
  rpc: jest.Mock;
};

type LoadOptions = {
  supabase?: SupabaseMock | null;
};

const defaultConfig = {
  configurationIssue: null,
  isConfigured: true,
  redirectURL: 'spotlight://login-callback',
};

function makeSupabaseMock(): SupabaseMock {
  return {
    auth: {
      exchangeCodeForSession: jest.fn(),
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      setSession: jest.fn(),
    },
    from: jest.fn(),
    rpc: jest.fn(),
  };
}

async function loadAuthService(options: LoadOptions = {}) {
  jest.resetModules();

  const supabase = options.supabase === undefined ? makeSupabaseMock() : options.supabase;

  jest.doMock('@/lib/supabase', () => ({
    supabase,
    supabaseAuthConfig: defaultConfig,
  }));
  jest.doMock('expo-linking', () => ({ openURL: jest.fn() }));
  jest.doMock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
  jest.doMock('expo-apple-authentication', () => ({
    AppleAuthenticationScope: { EMAIL: 'EMAIL', FULL_NAME: 'FULL_NAME' },
    isAvailableAsync: jest.fn().mockResolvedValue(false),
    signInAsync: jest.fn(),
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require('@/features/auth/auth-service') as typeof import('@/features/auth/auth-service');

  return { service, supabase };
}

/*
  GoTrue reports OAuth callback failures in TWO shapes: `error_code`, or
  `error` + `error_description` (the only shape linkIdentity rejections use).
  Missing the second shape made the Android deep-link path a silent no-op and
  left a returning user stuck signed out — checklist 2026-08-12, line 97.
*/
describe('auth-service restoreSessionFromUrl error callbacks', () => {
  it('throws on error/error_description params, using the decoded description as the message', async () => {
    const { service, supabase } = await loadAuthService();

    const url = 'spotlight://login-callback#error=server_error&error_description=Identity+is+already+linked+to+another+user';
    await expect(service.restoreSessionFromUrl(url)).rejects.toThrow(
      'Identity is already linked to another user',
    );
    expect(supabase!.auth.setSession).not.toHaveBeenCalled();
    expect(supabase!.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('produces an error the identity-already-linked fallback recognizes', async () => {
    const { service } = await loadAuthService();

    const thrown: unknown = await service
      .restoreSessionFromUrl('spotlight://login-callback?error=server_error&error_description=Identity+is+already+linked+to+another+user')
      .catch((error: unknown) => error);

    expect(service.isIdentityAlreadyLinkedError(thrown)).toBe(true);
  });

  it('throws on a bare error param, using the error value as the message', async () => {
    const { service } = await loadAuthService();

    await expect(
      service.restoreSessionFromUrl('spotlight://login-callback?error=access_denied'),
    ).rejects.toThrow('access_denied');
  });

  it('still throws on error_code, preferring error_description as the message', async () => {
    const { service } = await loadAuthService();

    await expect(
      service.restoreSessionFromUrl('spotlight://login-callback?error_code=identity_already_exists'),
    ).rejects.toThrow('identity_already_exists');

    await expect(
      service.restoreSessionFromUrl('spotlight://login-callback?error_code=otp_expired&error_description=Email+link+is+invalid'),
    ).rejects.toThrow('Email link is invalid');
  });

  it('still restores a session from callback tokens', async () => {
    const session = { access_token: 'access-token', refresh_token: 'refresh-token' };
    const supabase = makeSupabaseMock();
    supabase.auth.setSession.mockResolvedValue({ data: { session }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(
      service.restoreSessionFromUrl('spotlight://login-callback#access_token=access-token&refresh_token=refresh-token'),
    ).resolves.toBe(session);
    expect(supabase.auth.setSession).toHaveBeenCalledWith({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
  });

  it('returns null for a callback with no tokens, code, or error', async () => {
    const { service } = await loadAuthService();

    await expect(service.restoreSessionFromUrl('spotlight://login-callback')).resolves.toBeNull();
  });
});
