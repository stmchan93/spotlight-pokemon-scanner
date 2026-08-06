type SupabaseMock = {
  auth: {
    getSession: jest.Mock;
    linkIdentity: jest.Mock;
    resend: jest.Mock;
    resetPasswordForEmail: jest.Mock;
    setSession: jest.Mock;
    signInWithPassword: jest.Mock;
    signUp: jest.Mock;
    updateUser: jest.Mock;
    verifyOtp: jest.Mock;
  };
  from: jest.Mock;
  rpc: jest.Mock;
};

type LoadOptions = {
  config?: Record<string, unknown>;
  supabase?: SupabaseMock | null;
};

const defaultConfig = {
  configurationIssue: null,
  isConfigured: true,
  redirectURL: 'spotlight://login-callback',
};

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    user: {
      email: 'collector@example.com',
      id: 'user-1',
      identities: [],
      user_metadata: {},
    },
    ...overrides,
  };
}

function makeSupabaseMock(): SupabaseMock {
  return {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      linkIdentity: jest.fn(),
      resend: jest.fn().mockResolvedValue({ data: {}, error: null }),
      resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
      setSession: jest.fn(),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
      verifyOtp: jest.fn(),
    },
    from: jest.fn(),
    rpc: jest.fn(),
  };
}

/** Make `getCurrentSession()` report a guest (anonymous) session. */
function withAnonymousSession(supabase: SupabaseMock, userID = 'guest-1') {
  const session = makeSession({
    user: { id: userID, email: null, identities: [], is_anonymous: true, user_metadata: {} },
  });
  supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  return session;
}

/** Silence the profile upsert that `bootstrapProfileIfNeeded` performs. */
function stubProfileWrites(supabase: SupabaseMock) {
  const single = jest.fn().mockResolvedValue({ data: null, error: new Error('no profile') });
  const select = jest.fn(() => ({ single }));
  const upsert = jest.fn(() => ({ select }));
  const eq = jest.fn(() => ({ single }));
  supabase.from.mockReturnValue({ select: jest.fn(() => ({ eq })), upsert });
}

async function loadAuthService(options: LoadOptions = {}) {
  jest.resetModules();

  const supabase = options.supabase === undefined ? makeSupabaseMock() : options.supabase;
  const openAuthSessionAsync = jest.fn();
  const appleSignInAsync = jest.fn();

  jest.doMock('@/lib/supabase', () => ({
    supabase,
    supabaseAuthConfig: {
      ...defaultConfig,
      ...(options.config ?? {}),
    },
  }));
  jest.doMock('expo-linking', () => ({ openURL: jest.fn() }));
  jest.doMock('expo-web-browser', () => ({ openAuthSessionAsync }));
  jest.doMock('expo-apple-authentication', () => ({
    AppleAuthenticationScope: { EMAIL: 'EMAIL', FULL_NAME: 'FULL_NAME' },
    isAvailableAsync: jest.fn().mockResolvedValue(false),
    signInAsync: appleSignInAsync,
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require('@/features/auth/auth-service') as typeof import('@/features/auth/auth-service');

  return { appleSignInAsync, openAuthSessionAsync, service, supabase };
}

describe('auth-service checkEmailExists', () => {
  it('passes the trimmed email and returns the boolean from the RPC', async () => {
    const supabase = makeSupabaseMock();
    supabase.rpc.mockResolvedValue({ data: true, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.checkEmailExists('  collector@example.com  ')).resolves.toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('email_exists', {
      p_email: 'collector@example.com',
    });

    supabase.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(service.checkEmailExists('missing@example.com')).resolves.toBe(false);
  });

  it('throws when the RPC returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('rpc failed') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.checkEmailExists('collector@example.com')).rejects.toThrow('rpc failed');
  });

  it('throws a configuration error when Supabase is unavailable', async () => {
    const { service } = await loadAuthService({
      config: { configurationIssue: 'Missing Supabase URL.' },
      supabase: null,
    });

    await expect(service.checkEmailExists('collector@example.com')).rejects.toThrow('Missing Supabase URL.');
  });
});

describe('auth-service signUpWithEmail', () => {
  it('returns needsCode=true when no session is returned and forwards the display name', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signUp.mockResolvedValue({ data: { session: null }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signUpWithEmail({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      fullName: '  Apple Collector  ',
    })).resolves.toEqual({ needsCode: true, session: null });

    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      options: { data: { display_name: 'Apple Collector' } },
    });
  });

  it('returns needsCode=false and the session when sign-up returns a session', async () => {
    const supabase = makeSupabaseMock();
    const session = makeSession();
    supabase.auth.signUp.mockResolvedValue({ data: { session }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signUpWithEmail({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      fullName: 'Collector',
    })).resolves.toEqual({ needsCode: false, session });
  });

  it('throws when sign-up returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signUp.mockResolvedValue({ data: { session: null }, error: new Error('signup failed') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signUpWithEmail({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      fullName: 'Collector',
    })).rejects.toThrow('signup failed');
  });
});

describe('auth-service signInWithEmailPassword', () => {
  it('returns the session on success', async () => {
    const supabase = makeSupabaseMock();
    const session = makeSession();
    supabase.auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    })).resolves.toBe(session);
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    });
  });

  it('throws when Supabase returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: new Error('invalid credentials'),
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'wrong',
    })).rejects.toThrow('invalid credentials');
  });

  it('throws when no session is returned', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    })).rejects.toThrow('Sign-in did not create a session.');
  });

  it('maps invalid credentials to "This account does not exist" when the email has no account', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }),
    });
    // email_exists RPC → false (deleted / never existed).
    supabase.rpc.mockResolvedValue({ data: false, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'ghost@example.com',
      password: 'whatever12',
    })).rejects.toThrow('This account does not exist.');
    expect(supabase.rpc).toHaveBeenCalledWith('email_exists', { p_email: 'ghost@example.com' });
  });

  it('keeps the generic credentials error when the account exists (wrong password)', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }),
    });
    // email_exists RPC → true, so it's a real account with a bad password.
    supabase.rpc.mockResolvedValue({ data: true, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'wrong',
    })).rejects.toThrow('Invalid login credentials');
  });

  it('falls back to the generic error if the existence check itself fails', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }),
    });
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('rpc down') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'wrong',
    })).rejects.toThrow('Invalid login credentials');
  });
});

describe('auth-service verifySignupCode', () => {
  it('verifies with type signup, bootstraps the profile, and returns the session', async () => {
    const supabase = makeSupabaseMock();
    const session = makeSession();
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session }, error: null });
    // bootstrapProfileIfNeeded persists via upsert -> from('user_profiles').
    // Make the profile DB calls no-op so we never hit a real DB.
    const single = jest.fn().mockResolvedValue({ data: null, error: new Error('no profile') });
    const select = jest.fn(() => ({ single }));
    const upsert = jest.fn(() => ({ select }));
    const eq = jest.fn(() => ({ single }));
    supabase.from.mockReturnValue({ select: jest.fn(() => ({ eq })), upsert });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifySignupCode({
      email: 'collector@example.com',
      code: '  123456  ',
      fullName: 'Collector',
    })).resolves.toBe(session);

    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      token: '123456',
      type: 'signup',
    });
  });

  it('throws when verification returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: new Error('invalid code'),
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifySignupCode({
      email: 'collector@example.com',
      code: '000000',
    })).rejects.toThrow('invalid code');
  });
});

describe('auth-service verifyRecoveryCode', () => {
  it('verifies with type recovery and returns the session', async () => {
    const supabase = makeSupabaseMock();
    const session = makeSession();
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyRecoveryCode({
      email: 'collector@example.com',
      code: ' 654321 ',
    })).resolves.toBe(session);
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      token: '654321',
      type: 'recovery',
    });
  });

  it('throws when verification returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: new Error('expired code'),
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyRecoveryCode({
      email: 'collector@example.com',
      code: '000000',
    })).rejects.toThrow('expired code');
  });
});

describe('auth-service resendSignupCode', () => {
  it('calls resend with type signup', async () => {
    const supabase = makeSupabaseMock();

    const { service } = await loadAuthService({ supabase });

    await expect(service.resendSignupCode('collector@example.com')).resolves.toBeUndefined();
    expect(supabase.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'collector@example.com',
    });
  });

  it('throws when resend returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.resend.mockResolvedValue({ data: {}, error: new Error('resend failed') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.resendSignupCode('collector@example.com')).rejects.toThrow('resend failed');
  });
});

describe('auth-service sendPasswordReset', () => {
  it('calls resetPasswordForEmail with the trimmed email', async () => {
    const supabase = makeSupabaseMock();

    const { service } = await loadAuthService({ supabase });

    await expect(service.sendPasswordReset('  collector@example.com  ')).resolves.toBeUndefined();
    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('collector@example.com');
  });

  it('throws when reset returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: new Error('reset failed'),
    });

    const { service } = await loadAuthService({ supabase });

    await expect(service.sendPasswordReset('collector@example.com')).rejects.toThrow('reset failed');
  });
});

describe('auth-service updatePassword', () => {
  it('calls updateUser with the new password', async () => {
    const supabase = makeSupabaseMock();

    const { service } = await loadAuthService({ supabase });

    await expect(service.updatePassword('newhunter2hunter2')).resolves.toBeUndefined();
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'newhunter2hunter2' });
  });

  it('throws when updateUser returns an error', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: new Error('update failed') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.updatePassword('newhunter2hunter2')).rejects.toThrow('update failed');
  });
});

// The point of every test below: a guest converting to a real account must keep
// the SAME auth uuid. A new uuid orphans their backend-owned rows
// (`owner_user_id` IS the Supabase uuid) and bills a second Monthly Active User.
// `signUp()` mints a new uuid, so it must never appear in these paths.
describe('auth-service convertAnonymousUserToEmailAccount', () => {
  it('attaches the email to the EXISTING anonymous user and never calls signUp', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);

    const { service } = await loadAuthService({ supabase });

    await expect(service.convertAnonymousUserToEmailAccount({
      email: '  collector@example.com  ',
      fullName: '  Apple Collector  ',
    })).resolves.toEqual({ needsCode: true });

    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      email: 'collector@example.com',
      data: { display_name: 'Apple Collector' },
    });
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('omits the metadata write when no name is supplied', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);

    const { service } = await loadAuthService({ supabase });

    await service.convertAnonymousUserToEmailAccount({ email: 'collector@example.com' });

    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ email: 'collector@example.com' });
  });

  it('refuses to touch a REAL account', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.convertAnonymousUserToEmailAccount({
      email: 'collector@example.com',
    })).rejects.toThrow('This session is already a real account.');
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses when there is no session at all', async () => {
    const supabase = makeSupabaseMock();

    const { service } = await loadAuthService({ supabase });

    await expect(service.convertAnonymousUserToEmailAccount({
      email: 'collector@example.com',
    })).rejects.toThrow('There is no guest session to convert.');
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('throws when the email update is rejected', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: new Error('email taken') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.convertAnonymousUserToEmailAccount({
      email: 'collector@example.com',
    })).rejects.toThrow('email taken');
  });
});

describe('auth-service verifyAnonymousEmailConversion', () => {
  it('verifies with type email_change, then sets the password on the same user', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase, 'guest-1');
    stubProfileWrites(supabase);
    // The upgraded session keeps the guest's uuid — that is the whole point.
    const upgraded = makeSession({
      user: { id: 'guest-1', email: 'collector@example.com', identities: [], user_metadata: {} },
    });
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session: upgraded }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyAnonymousEmailConversion({
      email: 'collector@example.com',
      code: '  123456  ',
      password: 'hunter2hunter2',
      fullName: 'Collector',
    })).resolves.toBe(upgraded);

    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      token: '123456',
      type: 'email_change',
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('warns when the uuid moved (data would be orphaned) but still returns the session', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase, 'guest-1');
    stubProfileWrites(supabase);
    const upgraded = makeSession({
      user: { id: 'someone-else', email: 'collector@example.com', identities: [], user_metadata: {} },
    });
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session: upgraded }, error: null });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyAnonymousEmailConversion({
      email: 'collector@example.com',
      code: '123456',
      password: 'hunter2hunter2',
    })).resolves.toBe(upgraded);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('changed the user id'),
      { from: 'guest-1', to: 'someone-else' },
    );

    warn.mockRestore();
  });

  it('refuses to run against a real account', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyAnonymousEmailConversion({
      email: 'collector@example.com',
      code: '123456',
      password: 'hunter2hunter2',
    })).rejects.toThrow('This session is already a real account.');
    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('throws when the code is wrong, without touching the password', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: new Error('invalid code') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyAnonymousEmailConversion({
      email: 'collector@example.com',
      code: '000000',
      password: 'hunter2hunter2',
    })).rejects.toThrow('invalid code');
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('throws when the password write fails', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase, 'guest-1');
    const upgraded = makeSession({
      user: { id: 'guest-1', email: 'collector@example.com', identities: [], user_metadata: {} },
    });
    supabase.auth.verifyOtp.mockResolvedValue({ data: { session: upgraded }, error: null });
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: new Error('weak password') });

    const { service } = await loadAuthService({ supabase });

    await expect(service.verifyAnonymousEmailConversion({
      email: 'collector@example.com',
      code: '123456',
      password: 'short',
    })).rejects.toThrow('weak password');
  });
});

describe('auth-service linkOAuthIdentityToCurrentUser', () => {
  it('links the provider to the current guest and restores the upgraded session', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);
    supabase.auth.linkIdentity.mockResolvedValue({
      data: { url: 'https://auth.example.com/authorize' },
      error: null,
    });
    const upgraded = makeSession();
    supabase.auth.setSession.mockResolvedValue({ data: { session: upgraded }, error: null });

    const { openAuthSessionAsync, service } = await loadAuthService({ supabase });
    openAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'spotlight://login-callback#access_token=a&refresh_token=b',
    });

    await expect(service.linkOAuthIdentityToCurrentUser('google')).resolves.toBe(upgraded);

    expect(supabase.auth.linkIdentity).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'spotlight://login-callback',
        skipBrowserRedirect: true,
      },
    });
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('refuses to link onto a real account', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    const { service } = await loadAuthService({ supabase });

    await expect(service.linkOAuthIdentityToCurrentUser('google'))
      .rejects.toThrow('This session is already a real account.');
    expect(supabase.auth.linkIdentity).not.toHaveBeenCalled();
  });

  it('maps a dismissed browser to the cancellation error', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase);
    supabase.auth.linkIdentity.mockResolvedValue({
      data: { url: 'https://auth.example.com/authorize' },
      error: null,
    });

    const { openAuthSessionAsync, service } = await loadAuthService({ supabase });
    openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });

    await expect(service.linkOAuthIdentityToCurrentUser('apple')).rejects.toThrow(
      'Authentication was canceled.',
    );
  });
});

describe('auth-service linkAppleIdentityToCurrentUser', () => {
  it('links the native Apple id token to the current guest', async () => {
    const supabase = makeSupabaseMock();
    withAnonymousSession(supabase, 'guest-1');
    stubProfileWrites(supabase);
    const upgraded = makeSession({
      user: { id: 'guest-1', email: 'collector@example.com', identities: [], user_metadata: {} },
    });
    supabase.auth.linkIdentity.mockResolvedValue({ data: { session: upgraded }, error: null });

    const { appleSignInAsync, service } = await loadAuthService({ supabase });
    appleSignInAsync.mockResolvedValue({
      authorizationCode: 'auth-code',
      fullName: { givenName: 'Ash', familyName: 'Ketchum' },
      identityToken: 'identity-token',
    });

    await expect(service.linkAppleIdentityToCurrentUser()).resolves.toBe(upgraded);

    expect(supabase.auth.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'apple',
      token: 'identity-token',
      access_token: 'auth-code',
    }));
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('refuses to link onto a real account', async () => {
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    const { appleSignInAsync, service } = await loadAuthService({ supabase });

    await expect(service.linkAppleIdentityToCurrentUser())
      .rejects.toThrow('This session is already a real account.');
    expect(appleSignInAsync).not.toHaveBeenCalled();
  });
});
