type SupabaseMock = {
  auth: {
    resend: jest.Mock;
    resetPasswordForEmail: jest.Mock;
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
      resend: jest.fn().mockResolvedValue({ data: {}, error: null }),
      resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
      verifyOtp: jest.fn(),
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
    supabaseAuthConfig: {
      ...defaultConfig,
      ...(options.config ?? {}),
    },
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
