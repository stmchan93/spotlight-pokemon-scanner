/**
 * Turnstile captcha plumbing.
 *
 * Three layers under test:
 *   1. The token provider (`getCaptchaToken`): resolves null immediately with
 *      no site key / no host, times out to null, and never throws — the
 *      graceful-degradation contract that keeps captcha-off environments
 *      (staging/dev) signing in exactly as before.
 *   2. The hidden WebView host: executes one fresh widget per request and
 *      relays the token (or null on widget error) back to the provider.
 *   3. auth-service: passes `captchaToken` through to the supabase calls when
 *      the provider returns a token, and omits it entirely when null.
 */
import { act, render } from '@testing-library/react-native';

type CapturedWebViewProps = {
  onError?: (event: unknown) => void;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  source?: { baseUrl?: string; html?: string };
};

let mockWebViewProps: CapturedWebViewProps | null = null;

// Override the global jest.setup mock: the host tests need to reach the
// WebView's onMessage/onError props to play the widget's side of the exchange.
jest.mock('react-native-webview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    WebView: (props: CapturedWebViewProps) => {
      mockWebViewProps = props;
      return React.createElement(View, { testID: 'captured-webview' });
    },
  };
});

const SITE_KEY = '0x4AAAAAAATestSiteKey';

function setSiteKey(value: string | undefined) {
  if (value === undefined) {
    delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  } else {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = value;
  }
}

describe('turnstile token provider', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const turnstile = require('@/features/auth/captcha/turnstile') as typeof import('@/features/auth/captcha/turnstile');

  afterEach(() => {
    setSiteKey(undefined);
    turnstile.resetTurnstileForTesting();
    jest.useRealTimers();
  });

  it('resolves null immediately when no site key is configured', async () => {
    const executor = jest.fn();
    turnstile.registerTurnstileExecutor(executor);

    await expect(turnstile.getCaptchaToken()).resolves.toBeNull();
    expect(executor).not.toHaveBeenCalled();
  });

  it('treats the TBD placeholder site key as absent', async () => {
    setSiteKey('TURNSTILE_SITE_KEY_TBD');
    const executor = jest.fn();
    turnstile.registerTurnstileExecutor(executor);

    await expect(turnstile.getCaptchaToken()).resolves.toBeNull();
    expect(executor).not.toHaveBeenCalled();
  });

  it('resolves null when no host has registered an executor', async () => {
    setSiteKey(SITE_KEY);

    await expect(turnstile.getCaptchaToken()).resolves.toBeNull();
  });

  it('resolves the token produced by the registered executor', async () => {
    setSiteKey(SITE_KEY);
    turnstile.registerTurnstileExecutor(jest.fn().mockResolvedValue('turnstile-token-1'));

    await expect(turnstile.getCaptchaToken()).resolves.toBe('turnstile-token-1');
  });

  it('resolves null when the executor rejects', async () => {
    setSiteKey(SITE_KEY);
    turnstile.registerTurnstileExecutor(jest.fn().mockRejectedValue(new Error('widget blew up')));

    await expect(turnstile.getCaptchaToken()).resolves.toBeNull();
  });

  it('times out to null when the widget never answers', async () => {
    jest.useFakeTimers();
    setSiteKey(SITE_KEY);
    turnstile.registerTurnstileExecutor(() => new Promise<string | null>(() => {}));

    const pending = turnstile.getCaptchaToken();
    await jest.advanceTimersByTimeAsync(turnstile.CAPTCHA_TOKEN_TIMEOUT_MS + 1);

    await expect(pending).resolves.toBeNull();
  });

  it('runs one fresh execution per call (tokens are single-use)', async () => {
    setSiteKey(SITE_KEY);
    const executor = jest.fn()
      .mockResolvedValueOnce('token-a')
      .mockResolvedValueOnce('token-b');
    turnstile.registerTurnstileExecutor(executor);

    await expect(turnstile.getCaptchaToken()).resolves.toBe('token-a');
    await expect(turnstile.getCaptchaToken()).resolves.toBe('token-b');
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('unregistering the executor returns the provider to the tokenless path', async () => {
    setSiteKey(SITE_KEY);
    const unregister = turnstile.registerTurnstileExecutor(
      jest.fn().mockResolvedValue('turnstile-token-1'),
    );
    unregister();

    await expect(turnstile.getCaptchaToken()).resolves.toBeNull();
  });
});

describe('TurnstileCaptchaHost', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const turnstile = require('@/features/auth/captcha/turnstile') as typeof import('@/features/auth/captcha/turnstile');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TurnstileCaptchaHost } = require('@/features/auth/captcha/turnstile-captcha-host') as typeof import('@/features/auth/captcha/turnstile-captcha-host');

  beforeEach(() => {
    mockWebViewProps = null;
  });

  afterEach(() => {
    setSiteKey(undefined);
    turnstile.resetTurnstileForTesting();
  });

  /**
   * Kick off a token request and flush the resulting WebView mount. Returns the
   * pending promise WRAPPED in an object: an async function that returned it
   * directly would assimilate it — `await requestToken()` would then block on
   * the widget answer itself and deadlock the test.
   */
  async function requestToken(): Promise<{ pending: Promise<string | null> }> {
    let pending: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      pending = turnstile.getCaptchaToken();
      // Let the provider's execution chain invoke the host's executor and the
      // resulting setState mount the WebView.
      await Promise.resolve();
    });
    return { pending };
  }

  it('renders nothing until a token is requested', () => {
    setSiteKey(SITE_KEY);
    const { queryByTestId } = render(<TurnstileCaptchaHost />);

    expect(queryByTestId('turnstile-captcha-host')).toBeNull();
  });

  it('mounts the widget page on demand and relays the token back', async () => {
    setSiteKey(SITE_KEY);
    const { queryByTestId } = render(<TurnstileCaptchaHost />);

    const { pending } = await requestToken();
    expect(queryByTestId('turnstile-captcha-host')).not.toBeNull();
    expect(mockWebViewProps?.source?.baseUrl).toBe('https://ekalight.com');
    expect(mockWebViewProps?.source?.html).toContain(SITE_KEY);
    expect(mockWebViewProps?.source?.html).toContain('challenges.cloudflare.com/turnstile/v0/api.js');

    await act(async () => {
      mockWebViewProps?.onMessage?.({
        nativeEvent: { data: JSON.stringify({ type: 'token', token: 'widget-token-1' }) },
      });
    });

    await expect(pending).resolves.toBe('widget-token-1');
    // The widget page unmounts once the execution settles.
    expect(queryByTestId('turnstile-captcha-host')).toBeNull();
  });

  it('resolves null when the widget reports an error', async () => {
    setSiteKey(SITE_KEY);
    render(<TurnstileCaptchaHost />);

    const { pending } = await requestToken();

    await act(async () => {
      mockWebViewProps?.onMessage?.({
        nativeEvent: { data: JSON.stringify({ type: 'error' }) },
      });
    });

    await expect(pending).resolves.toBeNull();
  });

  it('resolves null when the WebView itself fails to load', async () => {
    setSiteKey(SITE_KEY);
    render(<TurnstileCaptchaHost />);

    const { pending } = await requestToken();

    await act(async () => {
      mockWebViewProps?.onError?.({});
    });

    await expect(pending).resolves.toBeNull();
  });

  it('releases an in-flight request when the host unmounts', async () => {
    setSiteKey(SITE_KEY);
    const { unmount } = render(<TurnstileCaptchaHost />);

    const { pending } = await requestToken();
    unmount();

    await expect(pending).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// auth-service plumbing: token present → captchaToken forwarded; token null →
// key omitted so the request shape matches today's captcha-off behavior.
// ---------------------------------------------------------------------------

type SupabaseAuthMock = {
  auth: {
    getSession: jest.Mock;
    resend: jest.Mock;
    resetPasswordForEmail: jest.Mock;
    signInAnonymously: jest.Mock;
    signInWithPassword: jest.Mock;
    signUp: jest.Mock;
    updateUser: jest.Mock;
  };
  from: jest.Mock;
  rpc: jest.Mock;
};

function makeSupabaseMock(): SupabaseAuthMock {
  const session = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    user: { email: 'collector@example.com', id: 'user-1', identities: [], user_metadata: {} },
  };

  return {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      resend: jest.fn().mockResolvedValue({ data: {}, error: null }),
      resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
      signInAnonymously: jest.fn().mockResolvedValue({
        data: {
          session: {
            ...session,
            user: { ...session.user, id: 'anon-1', is_anonymous: true },
          },
        },
        error: null,
      }),
      signInWithPassword: jest.fn().mockResolvedValue({ data: { session }, error: null }),
      signUp: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
    },
    from: jest.fn(),
    rpc: jest.fn(),
  };
}

async function loadAuthServiceWithCaptcha(token: string | null) {
  jest.resetModules();

  const supabase = makeSupabaseMock();
  const getCaptchaToken = jest.fn().mockResolvedValue(token);

  jest.doMock('@/lib/supabase', () => ({
    supabase,
    supabaseAuthConfig: {
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://login-callback',
    },
  }));
  jest.doMock('@/features/auth/captcha/turnstile', () => ({
    getCaptchaToken,
  }));
  jest.doMock('@/features/auth/anonymous-identity-churn', () => ({
    markAnonymousIdentityReleased: jest.fn(),
    recordAnonymousIdentityMint: jest.fn(),
  }));
  jest.doMock('expo-linking', () => ({ openURL: jest.fn() }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require('@/features/auth/auth-service') as typeof import('@/features/auth/auth-service');

  return { getCaptchaToken, service, supabase };
}

describe('auth-service captcha plumbing', () => {
  it('passes the captcha token to signUp when the provider returns one', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-1');

    await service.signUpWithEmail({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      fullName: 'Collector',
    });

    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      options: {
        captchaToken: 'captcha-1',
        data: { display_name: 'Collector' },
      },
    });
  });

  it('omits captchaToken from signUp when the provider returns null', async () => {
    const { getCaptchaToken, service, supabase } = await loadAuthServiceWithCaptcha(null);

    await service.signUpWithEmail({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      fullName: 'Collector',
    });

    expect(getCaptchaToken).toHaveBeenCalled();
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      options: { data: { display_name: 'Collector' } },
    });
  });

  it('passes the captcha token to signInWithPassword', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-2');

    await service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    });

    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      options: { captchaToken: 'captcha-2' },
    });
  });

  it('keeps the exact tokenless signInWithPassword shape when null', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha(null);

    await service.signInWithEmailPassword({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    });

    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
    });
  });

  it('passes the captcha token to the anonymous (guest) mint', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-3');

    await service.signInAnonymously();

    expect(supabase.auth.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: 'captcha-3' },
    });
  });

  it('mints the guest with the zero-argument call when the token is null', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha(null);

    await service.signInAnonymously();

    expect(supabase.auth.signInAnonymously).toHaveBeenCalledWith();
  });

  it('passes the captcha token to resetPasswordForEmail', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-4');

    await service.sendPasswordReset('collector@example.com');

    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'collector@example.com',
      { captchaToken: 'captcha-4' },
    );
  });

  it('calls resetPasswordForEmail with only the email when the token is null', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha(null);

    await service.sendPasswordReset('collector@example.com');

    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('collector@example.com');
  });

  it('passes the captcha token to resend', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-5');

    await service.resendSignupCode('collector@example.com');

    expect(supabase.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'collector@example.com',
      options: { captchaToken: 'captcha-5' },
    });
  });

  it('omits the resend options when the token is null', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha(null);

    await service.resendSignupCode('collector@example.com');

    expect(supabase.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'collector@example.com',
    });
  });

  it('carries the token on the change-password re-verification sign-in', async () => {
    const { service, supabase } = await loadAuthServiceWithCaptcha('captcha-6');
    supabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          user: { email: 'collector@example.com', id: 'user-1' },
        },
      },
      error: null,
    });

    await service.updatePassword('newhunter2hunter2', { currentPassword: 'hunter2hunter2' });

    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'collector@example.com',
      password: 'hunter2hunter2',
      options: { captchaToken: 'captcha-6' },
    });
  });
});
