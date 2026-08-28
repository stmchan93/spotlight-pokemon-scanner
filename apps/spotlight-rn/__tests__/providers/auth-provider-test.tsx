describe('AuthProvider', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.clearAllMocks();
    jest.resetModules();
    jest.unmock('expo-linking');
    jest.unmock('@/features/auth/auth-service');
    jest.unmock('@/features/auth/guest-first-launch');
    jest.unmock('@/lib/observability/posthog');
    jest.unmock('@/lib/supabase');
  });

  function renderAuthProvider({
    nodeEnv = 'development',
    authServiceOverrides,
    initialURL = null,
    // Default to a device that has signed in before, i.e. the ordinary
    // signed-out login flow. First-launch/guest tests opt into `false`, which
    // now (deferred mint on) means pending-guest rather than signed-out.
    hasSignedInBefore = true,
    // Deferring the mint is the shipped DEFAULT; the flag only exists as an
    // emergency rollback, so tests of the legacy eager mint must turn it off
    // explicitly (which also proves the rollback switch still works).
    deferGuestSession = true,
  }: {
    nodeEnv?: string;
    authServiceOverrides?: Record<string, unknown>;
    initialURL?: string | null;
    hasSignedInBefore?: boolean;
    deferGuestSession?: boolean;
  } = {}) {
    process.env = {
      ...originalEnv,
      NODE_ENV: nodeEnv,
      EXPO_PUBLIC_SPOTLIGHT_DEFER_GUEST_SESSION: deferGuestSession ? '1' : '0',
    } as NodeJS.ProcessEnv;

    const capturePostHogEvent = jest.fn();
    const markHasSignedIn = jest.fn(async () => {});
    const linkRemove = jest.fn();
    const authUnsubscribe = jest.fn();
    let authStateChangeHandler:
      | ((event: string, session: any) => void)
      | null = null;
    let linkURLHandler: ((event: { url: string }) => void) | null = null;

    const defaultSession = {
      access_token: 'access-token',
      user: {
        email: 'collector@example.com',
        id: 'user-1',
      },
    } as any;

    class MockAuthCanceledError extends Error {}

    const authService = {
      AuthCanceledError: MockAuthCanceledError,
      bootstrapProfileIfNeeded: jest.fn(async () => {}),
      checkAppleSignInAvailability: jest.fn(async () => false),
      getAccessToken: jest.fn((session) => (session ? 'access-token' : null)),
      getConfigurationIssue: jest.fn(() => null),
      getCurrentSession: jest.fn(async () => null),
      getIsConfigured: jest.fn(() => true),
      getNeedsProfile: jest.fn((user) => !user.displayName),
      isAnonymousSession: jest.fn((session) => session?.user?.is_anonymous === true),
      isAuthCanceledError: jest.fn((error) => error instanceof MockAuthCanceledError),
      // Mirrors the real detector so URL-handler fallback tests behave like prod.
      isIdentityAlreadyLinkedError: jest.fn((error) =>
        error?.code === 'identity_already_exists'
        || (typeof error?.message === 'string' && error.message.toLowerCase().includes('already linked'))),
      fetchAuthUserError: jest.fn(async () => null),
      clearStoredSession: jest.fn(async () => {}),
      signInAnonymously: jest.fn(async () => null),
      signUpWithEmail: jest.fn(async () => ({ needsCode: true, session: null })),
      verifySignupCode: jest.fn(async () => null),
      convertAnonymousUserToEmailAccount: jest.fn(async () => ({ needsCode: true })),
      verifyAnonymousEmailConversion: jest.fn(async () => null),
      linkOAuthIdentityToCurrentUser: jest.fn(async () => null),
      linkAppleIdentityToCurrentUser: jest.fn(async () => null),
      resolveAppUserFromSession: jest.fn(async (session) => ({
        adminEnabled: false,
        avatarURL: null,
        displayName: 'Collector',
        email: session?.user?.email ?? 'collector@example.com',
        id: session?.user?.id ?? 'user-1',
        labelerEnabled: true,
        providers: ['google'],
      })),
      restoreSessionFromUrl: jest.fn(async () => null),
      signInWithApple: jest.fn(async () => null),
      signInWithGoogle: jest.fn(async () => null),
      signOut: jest.fn(async () => {}),
      updateProfile: jest.fn(async () => null),
      upsertProfile: jest.fn(async () => {}),
      ...authServiceOverrides,
    };

    jest.doMock('expo-linking', () => ({
      addEventListener: jest.fn((_event, callback) => {
        linkURLHandler = callback;
        return {
          callback,
          remove: linkRemove.mockImplementation(() => undefined),
        };
      }),
      getInitialURL: jest.fn(async () => initialURL),
    }));
    jest.doMock('@/features/auth/auth-service', () => authService);
    jest.doMock('@/lib/observability/posthog', () => ({
      capturePostHogEvent,
    }));
    jest.doMock('@/features/auth/guest-first-launch', () => ({
      hasEverSignedIn: jest.fn(async () => hasSignedInBefore),
      markHasSignedIn,
    }));
    jest.doMock('@/lib/supabase', () => ({
      supabase: {
        auth: {
          onAuthStateChange: jest.fn((callback) => {
            authStateChangeHandler = callback;
            return {
              data: {
                subscription: {
                  unsubscribe: authUnsubscribe,
                },
              },
            };
          }),
        },
      },
    }));

    let testingLibrary: typeof import('@testing-library/react-native/pure');
    let authModule: typeof import('@/providers/auth-provider');
    let view: ReturnType<typeof import('@testing-library/react-native/pure')['render']>;

    jest.isolateModules(() => {
      const React = require('react') as typeof import('react');
      const ReactNative = require('react-native') as typeof import('react-native');
      testingLibrary = require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
      authModule = require('@/providers/auth-provider') as typeof import('@/providers/auth-provider');

      const { Pressable, Text, View } = ReactNative;
      const { AuthProvider, useAuth } = authModule;

      function Probe() {
        const auth = useAuth();

        return React.createElement(
          View,
          null,
          React.createElement(Text, { testID: 'state' }, `state:${auth.state}`),
          React.createElement(Text, { testID: 'user' }, `user:${auth.currentUser?.id ?? 'none'}`),
          React.createElement(Text, { testID: 'handle' }, `handle:${auth.currentUser?.handle ?? 'none'}`),
          React.createElement(Text, { testID: 'profile' }, `profile:${auth.profileDraftName || '<empty>'}`),
          React.createElement(Text, { testID: 'error' }, `error:${auth.errorMessage ?? 'none'}`),
          React.createElement(Text, { testID: 'apple' }, `apple:${String(auth.appleSignInAvailable)}`),
          React.createElement(Text, { testID: 'configured' }, `configured:${String(auth.isConfigured)}`),
          React.createElement(Text, { testID: 'config-issue' }, `config:${auth.configurationIssue ?? 'none'}`),
          React.createElement(Text, { testID: 'token' }, `token:${auth.accessToken ?? 'none'}`),
          React.createElement(Text, { testID: 'live-token' }, `live-token:${auth.getAccessToken() ?? 'none'}`),
          React.createElement(Text, { testID: 'guest' }, `guest:${String(auth.isGuest)}`),
          React.createElement(Pressable, {
            testID: 'sign-up-email',
            onPress: () => {
              void auth.signUpEmail({
                email: 'new@example.com',
                fullName: 'New Trainer',
                password: 'hunter2hunter2',
              }).catch(() => {});
            },
          }),
          React.createElement(Pressable, {
            testID: 'verify-code',
            onPress: () => {
              void auth.verifyCode({
                code: '123456',
                email: 'new@example.com',
                fullName: 'New Trainer',
                password: 'hunter2hunter2',
              }).catch(() => {});
            },
          }),
          React.createElement(Pressable, {
            testID: 'ensure-guest-session',
            // Fired twice on purpose: the mint must be single-flight, or a burst
            // of gated actions would bill several anonymous MAUs for one device.
            onPress: () => {
              void auth.ensureGuestSession();
              void auth.ensureGuestSession();
            },
          }),
          React.createElement(Pressable, { testID: 'sign-in-apple', onPress: () => { void auth.signInWithApple(); } }),
          React.createElement(Pressable, { testID: 'sign-in-google', onPress: () => { void auth.signInWithGoogle(); } }),
          React.createElement(Pressable, { testID: 'sign-out', onPress: () => { void auth.signOut(); } }),
          React.createElement(Pressable, { testID: 'set-empty-name', onPress: () => auth.setProfileDraftName('   ') }),
          React.createElement(Pressable, { testID: 'set-profile-name', onPress: () => auth.setProfileDraftName('  Misty  ') }),
          React.createElement(Pressable, { testID: 'submit-profile', onPress: () => { void auth.submitProfile(); } }),
          React.createElement(Pressable, { testID: 'submit-handle', onPress: () => { void auth.submitHandle('misty'); } }),
        );
      }

      view = testingLibrary.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(Probe),
        ),
      );
    });

    return {
      ...view!,
      act: testingLibrary!.act,
      authModule: authModule!,
      authService,
      authStateChangeHandler,
      authUnsubscribe,
      capturePostHogEvent,
      defaultSession,
      fireEvent: testingLibrary!.fireEvent,
      // Getter, not the value: the listener registers in an effect after render.
      getLinkURLHandler: () => linkURLHandler,
      linkRemove,
      markHasSignedIn,
      waitFor: testingLibrary!.waitFor,
    };
  }

  it('bypasses auth in test runtime with a deterministic signed-in user', () => {
    const { authService, getByText } = renderAuthProvider({
      nodeEnv: 'test',
    });

    expect(getByText('state:signedIn')).toBeTruthy();
    expect(getByText('user:00000000-0000-0000-0000-000000000001')).toBeTruthy();
    expect(getByText('profile:UI Test User')).toBeTruthy();
    expect(getByText('token:none')).toBeTruthy();
    expect(authService.getCurrentSession).not.toHaveBeenCalled();
  });

  it('loads an existing session from the auth callback URL and cleans up subscriptions', async () => {
    const currentSession = {
      access_token: 'restored-token',
      user: {
        email: 'collector@example.com',
        id: 'collector-1',
      },
    } as any;
    const { authService, authUnsubscribe, getByText, linkRemove, unmount, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      initialURL: 'spotlight://login-callback',
      authServiceOverrides: {
        checkAppleSignInAvailability: jest.fn(async () => true),
        getConfigurationIssue: jest.fn(() => 'config issue'),
        getCurrentSession: jest.fn(async () => currentSession),
        getIsConfigured: jest.fn(() => false),
        getNeedsProfile: jest.fn(() => true),
        resolveAppUserFromSession: jest.fn(async () => ({
          adminEnabled: false,
          avatarURL: null,
          displayName: null,
          email: 'collector@example.com',
          id: 'collector-1',
          labelerEnabled: true,
          providers: ['google'],
        })),
        restoreSessionFromUrl: jest.fn(async () => currentSession),
      },
    });

    await waitFor(() => {
      expect(getByText('state:needsProfile')).toBeTruthy();
    });

    expect(getByText('apple:true')).toBeTruthy();
    expect(getByText('configured:false')).toBeTruthy();
    expect(getByText('config:config issue')).toBeTruthy();
    expect(getByText('token:access-token')).toBeTruthy();
    expect(getByText('profile:<empty>')).toBeTruthy();
    expect(authService.restoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback');

    unmount();
    expect(linkRemove).toHaveBeenCalledTimes(1);
    expect(authUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('signs in with Google, handles auth subscription updates, and signs out cleanly', async () => {
    jest.useFakeTimers();

    const currentSession = {
      access_token: 'google-token',
      user: {
        email: 'trainer@example.com',
        id: 'trainer-1',
      },
    } as any;
    const resolveAppUserFromSession = jest.fn(async () => ({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Trainer',
      email: 'trainer@example.com',
      id: 'trainer-1',
      labelerEnabled: true,
      providers: ['google'],
    }));

    const {
      act,
      authService,
      authStateChangeHandler,
      capturePostHogEvent,
      fireEvent,
      getByTestId,
      getByText,
      waitFor,
    } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        getNeedsProfile: jest.fn(() => false),
        resolveAppUserFromSession,
        signInWithGoogle: jest.fn(async () => currentSession),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    expect(authService.bootstrapProfileIfNeeded).toHaveBeenCalledWith(currentSession.user, null, null);
    expect(capturePostHogEvent).toHaveBeenCalledWith('auth_sign_in_succeeded', {
      provider: 'google',
    });

    await act(async () => {
      const nextHandler = authStateChangeHandler as ((event: string, session: any) => void) | null;
      if (nextHandler) {
        nextHandler('TOKEN_REFRESHED', currentSession);
      }
      jest.runAllTimers();
    });

    await waitFor(() => {
      expect(resolveAppUserFromSession).toHaveBeenCalledWith(currentSession);
    });

    fireEvent.press(getByTestId('sign-out'));

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    expect(authService.signOut).toHaveBeenCalledTimes(1);
    expect(capturePostHogEvent).toHaveBeenCalledWith('auth_sign_out');
  });

  it('signs in with Apple and records the success event', async () => {
    const currentSession = {
      access_token: 'apple-token',
      user: {
        email: 'apple@example.com',
        id: 'apple-1',
      },
    } as any;
    const { authService, capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        getNeedsProfile: jest.fn(() => false),
        resolveAppUserFromSession: jest.fn(async () => ({
          adminEnabled: false,
          avatarURL: null,
          displayName: 'Apple Trainer',
          email: 'apple@example.com',
          id: 'apple-1',
          labelerEnabled: true,
          providers: ['apple'],
        })),
        signInWithApple: jest.fn(async () => currentSession),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('sign-in-apple'));

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    expect(authService.signInWithApple).toHaveBeenCalledTimes(1);
    expect(capturePostHogEvent).toHaveBeenCalledWith('auth_sign_in_succeeded', {
      provider: 'apple',
    });
  });

  it('suppresses auth errors for canceled Apple sign-in attempts', async () => {
    const canceledError = new Error('canceled');
    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        isAuthCanceledError: jest.fn((error) => error === canceledError),
        signInWithApple: jest.fn(async () => {
          throw canceledError;
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('sign-in-apple'));

    await waitFor(() => {
      expect(getByText('error:none')).toBeTruthy();
    });
    expect(capturePostHogEvent).not.toHaveBeenCalledWith('auth_sign_in_failed', expect.anything());
  });

  it('surfaces sign-in failures and records the PostHog failure event', async () => {
    const captureError = new Error('google boom');
    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        signInWithGoogle: jest.fn(async () => {
          throw captureError;
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(getByText('error:google boom')).toBeTruthy();
    });

    expect(capturePostHogEvent).toHaveBeenCalledWith('auth_sign_in_failed', {
      provider: 'google',
      reason_class: 'Error',
    });
  });

  it('surfaces restore-session callback failures from the incoming auth URL', async () => {
    const { getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      initialURL: 'spotlight://login-callback',
      authServiceOverrides: {
        restoreSessionFromUrl: jest.fn(async () => {
          throw new Error('callback restore failed');
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('error:callback restore failed')).toBeTruthy();
    });
  });

  it('falls back to the signed-out state when initial session bootstrap throws', async () => {
    const { getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => {
          throw new Error('secure store unavailable');
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
      expect(getByText('error:secure store unavailable')).toBeTruthy();
    });
  });

  it('signs out silently (no error banner) when the refresh token has expired', async () => {
    const { getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => {
          throw new Error('Invalid Refresh Token: Refresh Token Not Found');
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
      // Expected logout — no scary notification on the sign-in screen.
      expect(getByText('error:none')).toBeTruthy();
    });
  });

  it('validates blank profile submissions and completes profile setup when a name is provided', async () => {
    const currentSession = {
      access_token: 'profile-token',
      user: {
        email: 'misty@example.com',
        id: 'misty-1',
      },
    } as any;
    const resolveAppUserFromSession = jest.fn()
      .mockResolvedValueOnce({
        adminEnabled: false,
        avatarURL: 'https://cdn.spotlight.test/misty.png',
        displayName: null,
        email: 'misty@example.com',
        id: 'misty-1',
        labelerEnabled: true,
        providers: ['google'],
      })
      .mockResolvedValueOnce({
        adminEnabled: false,
        avatarURL: 'https://cdn.spotlight.test/misty.png',
        displayName: 'Misty',
        email: 'misty@example.com',
        id: 'misty-1',
        labelerEnabled: true,
        providers: ['google'],
      });

    const { authService, capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => currentSession),
        getNeedsProfile: jest.fn((user) => !user.displayName),
        resolveAppUserFromSession,
      },
    });

    await waitFor(() => {
      expect(getByText('state:needsProfile')).toBeTruthy();
    });

    fireEvent.press(getByTestId('set-empty-name'));
    fireEvent.press(getByTestId('submit-profile'));

    expect(getByText('error:Enter a display name to continue.')).toBeTruthy();

    fireEvent.press(getByTestId('set-profile-name'));
    fireEvent.press(getByTestId('submit-profile'));

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    expect(authService.upsertProfile).toHaveBeenCalledWith(
      'misty-1',
      'Misty',
      'https://cdn.spotlight.test/misty.png',
    );
    expect(getByText('profile:  Misty  ')).toBeTruthy();
    expect(capturePostHogEvent).toHaveBeenCalledWith('profile_completed');
  });

  it('returns early when submitProfile is triggered without a current user', async () => {
    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('submit-profile'));

    expect(authService.upsertProfile).not.toHaveBeenCalled();
    expect(getByText('state:signedOut')).toBeTruthy();
  });

  it('surfaces sign-out failures through the shared auth action wrapper', async () => {
    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signOut: jest.fn(async () => {
          throw new Error('sign out failed');
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-out'));

    await waitFor(() => {
      expect(getByText('error:sign out failed')).toBeTruthy();
    });
    expect(capturePostHogEvent).not.toHaveBeenCalledWith('auth_sign_out');
  });

  it('lands an anonymous (guest) session on signedIn as a synthetic Guest, skipping the profile fetch', async () => {
    jest.useFakeTimers();
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    const resolveAppUserFromSession = jest.fn();

    const { act, authStateChangeHandler, getByText, waitFor } = renderAuthProvider({
      nodeEnv: 'development',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        resolveAppUserFromSession,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    await act(async () => {
      const handler = authStateChangeHandler as ((event: string, session: any) => void) | null;
      handler?.('SIGNED_IN', guestSession);
      jest.runAllTimers();
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });
    // Synthetic Guest user; the profile fetch is skipped for anonymous sessions
    // (a guest has no display-name source and must not be trapped on the
    // profile-completion screen).
    expect(getByText('user:guest-1')).toBeTruthy();
    expect(resolveAppUserFromSession).not.toHaveBeenCalled();
  });

  it('ROLLBACK (flag off): first launch signs in anonymously and lands on the guest scanner', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    const signInAnonymously = jest.fn(async () => guestSession);
    const resolveAppUserFromSession = jest.fn();

    const { getByText, markHasSignedIn, waitFor } = renderAuthProvider({
      deferGuestSession: false,
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
        resolveAppUserFromSession,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(getByText('user:guest-1')).toBeTruthy();
    // A guest does NOT get a profile fetch, and does NOT set the has-signed-in
    // flag (so it only ever flips on a real login).
    expect(resolveAppUserFromSession).not.toHaveBeenCalled();
    expect(markHasSignedIn).not.toHaveBeenCalled();
  });

  // Supabase bills per Monthly Active User and an anonymous user is a billable
  // MAU, so opening the app must not create one.
  it('DEFAULT: first launch enters guest mode WITHOUT creating an anonymous user', async () => {
    const signInAnonymously = jest.fn(async () => {
      throw new Error('signInAnonymously must not run on app open');
    });

    const { getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });
    expect(signInAnonymously).not.toHaveBeenCalled();
    // Guest mode is fully live in the UI, it just has no server identity yet.
    expect(getByText('guest:true')).toBeTruthy();
    expect(getByText('token:none')).toBeTruthy();
  });

  it('DEFERRED MINT: ensureGuestSession mints exactly once and lands the guest session', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    const signInAnonymously = jest.fn(async () => guestSession);

    const { fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    fireEvent.press(getByTestId('ensure-guest-session'));

    await waitFor(() => {
      expect(getByText('user:guest-1')).toBeTruthy();
    });
    // Two concurrent calls, ONE anonymous user.
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(getByText('guest:true')).toBeTruthy();
    expect(getByText('token:access-token')).toBeTruthy();
  });

  // The anonymous-identity churn metric is hooked in exactly ONE place —
  // `signInAnonymously()` in auth-service, the only function that mints an
  // anonymous user. A second hook here would double-count every mint (and the
  // eager rollback path would still be missed), so the provider must stay silent.
  it('DEFERRED MINT: the provider does not report the mint itself (single hook point)', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;

    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously: jest.fn(async () => guestSession),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    fireEvent.press(getByTestId('ensure-guest-session'));

    await waitFor(() => {
      expect(getByText('user:guest-1')).toBeTruthy();
    });

    expect(capturePostHogEvent).not.toHaveBeenCalledWith(
      'auth_anonymous_identity_minted',
      expect.anything(),
    );
    // Same rule, restated for the guest-funnel work: the provider must not grow
    // its own mint event either. `auth_anonymous_identity_minted` is the one.
    expect(capturePostHogEvent).not.toHaveBeenCalledWith(
      'guest_session_minted',
      expect.anything(),
    );
  });

  /*
    ─────────────────────────────────────────────────────────────────────────
    THE GUEST FUNNEL IS A BILLING QUESTION.
    ─────────────────────────────────────────────────────────────────────────
    An anonymous user is a billable Supabase MAU, so a guest who is minted and
    never converts is a cost with nothing on the other side. These lock the two
    ends of that measurement: the free denominator, and the return.
  */
  it('GUEST FUNNEL: entering guest mode reports the free denominator', async () => {
    const { capturePostHogEvent, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });
    expect(capturePostHogEvent).toHaveBeenCalledWith('guest_mode_entered');
  });

  it('GUEST FUNNEL: a pending guest who converts before ever minting cost nothing', async () => {
    const realSession = {
      access_token: 'google-token',
      user: { email: 'trainer@example.com', id: 'trainer-1' },
    } as any;

    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        getNeedsProfile: jest.fn(() => false),
        signInWithGoogle: jest.fn(async () => realSession),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(getByText('user:trainer-1')).toBeTruthy();
    });

    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'guest_converted',
      expect.objectContaining({
        // Nothing was ever minted, so there is no duplicate to worry about and
        // this conversion never appeared on a Supabase bill as a guest.
        had_minted_session: false,
        preserved_identity: true,
        provider: 'google',
      }),
    );
  });

  /*
    THE EXPENSIVE MISTAKE THIS WATCHES FOR. Converting a guest by creating a NEW
    user instead of upgrading the anonymous one bills the same human twice.

    The shipped path does the right thing — a minted guest signing in with
    Google goes through `linkOAuthIdentityToCurrentUser`, which keeps the same
    Supabase uuid — and this pins that, so `preserved_identity` reads true.

    That is exactly why the property is worth sending. It costs nothing while
    the path stays correct, and it is the only thing that would notice from the
    outside if a future change quietly swapped the link for a fresh sign-up.
    If the ratio in PostHog is ever below ~1.0, this is what broke.
  */
  it('GUEST FUNNEL: converting a minted guest keeps the same Supabase user', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;

    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => guestSession),
        getNeedsProfile: jest.fn(() => false),
        linkOAuthIdentityToCurrentUser: jest.fn(async () => ({
          access_token: 'linked-token',
          user: { id: 'guest-1', email: 'linked@example.com', is_anonymous: false },
        })),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(capturePostHogEvent).toHaveBeenCalledWith(
        'guest_converted',
        expect.objectContaining({
          // They cost a billable MAU as a guest, and that same user is now a
          // real account — one person, one Supabase user, converted.
          had_minted_session: true,
          preserved_identity: true,
        }),
      );
    });
    expect(getByText('user:guest-1')).toBeTruthy();
  });

  it('GUEST FUNNEL: an ordinary signed-out login is NOT a conversion', async () => {
    const realSession = {
      access_token: 'google-token',
      user: { email: 'trainer@example.com', id: 'trainer-1' },
    } as any;

    const { capturePostHogEvent, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: true,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        getNeedsProfile: jest.fn(() => false),
        signInWithGoogle: jest.fn(async () => realSession),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));
    await waitFor(() => {
      expect(getByText('user:trainer-1')).toBeTruthy();
    });

    expect(capturePostHogEvent).not.toHaveBeenCalledWith(
      'guest_converted',
      expect.anything(),
    );
  });

  it('DEFERRED MINT: a failed mint keeps the user in guest mode instead of ejecting to login', async () => {
    const signInAnonymously = jest.fn(async () => {
      throw new Error('Anonymous sign-ins are disabled');
    });

    const { fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    fireEvent.press(getByTestId('ensure-guest-session'));

    await waitFor(() => {
      expect(signInAnonymously).toHaveBeenCalled();
    });
    expect(getByText('state:signedIn')).toBeTruthy();
    expect(getByText('guest:true')).toBeTruthy();
  });

  it('DEFERRED MINT: a returning device still goes straight to the login screen', async () => {
    const signInAnonymously = jest.fn();

    const { getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: true,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getByText('guest:false')).toBeTruthy();
  });

  it('RETURNING USER (has signed in before): shows the login screen and does NOT create a guest', async () => {
    const signInAnonymously = jest.fn(async () => {
      throw new Error('signInAnonymously must not be called for a returning device');
    });

    const { getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: true,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('ROLLBACK (flag off): anonymous sign-in failure (dashboard toggle off) drops to the login screen', async () => {
    const signInAnonymously = jest.fn(async () => {
      throw new Error('Anonymous sign-ins are disabled');
    });

    const { getByText, waitFor } = renderAuthProvider({
      deferGuestSession: false,
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('marks the has-signed-in flag when a real (non-anonymous) session is observed', async () => {
    jest.useFakeTimers();
    const realSession = {
      access_token: 'real-token',
      user: { id: 'trainer-1', email: 'trainer@example.com', is_anonymous: false },
    } as any;

    const { act, authStateChangeHandler, getByText, markHasSignedIn, waitFor } = renderAuthProvider({
      hasSignedInBefore: true,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        getNeedsProfile: jest.fn(() => false),
        resolveAppUserFromSession: jest.fn(async () => ({
          adminEnabled: false,
          avatarURL: null,
          displayName: 'Trainer',
          email: 'trainer@example.com',
          id: 'trainer-1',
          labelerEnabled: false,
          providers: ['email'],
        })),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    await act(async () => {
      const handler = authStateChangeHandler as ((event: string, session: any) => void) | null;
      handler?.('SIGNED_IN', realSession);
      jest.runAllTimers();
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });
    expect(markHasSignedIn).toHaveBeenCalled();
  });

  // The token has to be readable the INSTANT the session lands: the scan that
  // triggered the mint is already running inside a closure built before it, so a
  // render-snapshot token would send that first guest scan out unauthenticated.
  it('DEFERRED MINT: getAccessToken() reports the minted token without waiting for a render', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;

    const { fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        signInAnonymously: jest.fn(async () => guestSession),
      },
    });

    await waitFor(() => {
      expect(getByText('live-token:none')).toBeTruthy();
    });

    fireEvent.press(getByTestId('ensure-guest-session'));

    await waitFor(() => {
      expect(getByText('live-token:access-token')).toBeTruthy();
    });
  });

  it('GUEST SIGNUP: converts the anonymous user in place and never calls signUp', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    // Same uuid, no longer anonymous — that is the whole point of the flow.
    const convertedSession = {
      access_token: 'converted-token',
      user: { id: 'guest-1', email: 'new@example.com', is_anonymous: false },
    } as any;

    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => guestSession),
        getNeedsProfile: jest.fn(() => false),
        verifyAnonymousEmailConversion: jest.fn(async () => convertedSession),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-up-email'));

    await waitFor(() => {
      expect(authService.convertAnonymousUserToEmailAccount).toHaveBeenCalledWith({
        email: 'new@example.com',
        fullName: 'New Trainer',
      });
    });
    // signUp() would mint a SECOND uuid, orphaning every scan this guest owns.
    expect(authService.signUpWithEmail).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('verify-code'));

    await waitFor(() => {
      expect(getByText('guest:false')).toBeTruthy();
    });
    expect(authService.verifyAnonymousEmailConversion).toHaveBeenCalledWith({
      code: '123456',
      email: 'new@example.com',
      fullName: 'New Trainer',
      password: 'hunter2hunter2',
    });
    expect(authService.verifySignupCode).not.toHaveBeenCalled();
    // Same uuid before and after: the guest keeps their scans.
    expect(getByText('user:guest-1')).toBeTruthy();
  });

  it('GUEST SIGNUP: links Apple and Google to the existing anonymous user', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    const linkedSession = {
      access_token: 'linked-token',
      user: { id: 'guest-1', email: 'linked@example.com', is_anonymous: false },
    } as any;

    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => guestSession),
        getNeedsProfile: jest.fn(() => false),
        linkAppleIdentityToCurrentUser: jest.fn(async () => linkedSession),
        linkOAuthIdentityToCurrentUser: jest.fn(async () => linkedSession),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('sign-in-apple'));

    await waitFor(() => {
      expect(authService.linkAppleIdentityToCurrentUser).toHaveBeenCalledTimes(1);
    });
    expect(authService.signInWithApple).not.toHaveBeenCalled();
    expect(getByText('user:guest-1')).toBeTruthy();
  });

  it('GUEST SIGNUP: Google links to the anonymous user instead of signing in fresh', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;

    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => guestSession),
        getNeedsProfile: jest.fn(() => false),
        linkOAuthIdentityToCurrentUser: jest.fn(async () => ({
          access_token: 'linked-token',
          user: { id: 'guest-1', email: 'linked@example.com', is_anonymous: false },
        })),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(authService.linkOAuthIdentityToCurrentUser).toHaveBeenCalledWith('google');
    });
    expect(authService.signInWithGoogle).not.toHaveBeenCalled();
    expect(getByText('user:guest-1')).toBeTruthy();
  });

  // A signed-out visitor is NOT a guest: signUp is correct for them, and the
  // conversion helpers (which mutate the current user) must stay away.
  it('SIGNED-OUT SIGNUP: still creates a brand new account, untouched by the guest path', async () => {
    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-up-email'));

    await waitFor(() => {
      expect(authService.signUpWithEmail).toHaveBeenCalledTimes(1);
    });
    expect(authService.convertAnonymousUserToEmailAccount).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('verify-code'));

    await waitFor(() => {
      expect(authService.verifySignupCode).toHaveBeenCalledTimes(1);
    });
    expect(authService.verifyAnonymousEmailConversion).not.toHaveBeenCalled();
  });

  // A PENDING guest owns nothing (no Supabase user was ever minted), so there is
  // nothing to preserve — and taking the normal signup path means they never
  // cost an anonymous MAU at all.
  it('PENDING GUEST SIGNUP: takes the normal signup path, no anonymous user involved', async () => {
    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      hasSignedInBefore: false,
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-up-email'));

    await waitFor(() => {
      expect(authService.signUpWithEmail).toHaveBeenCalledTimes(1);
    });
    expect(authService.signInAnonymously).not.toHaveBeenCalled();
    expect(authService.convertAnonymousUserToEmailAccount).not.toHaveBeenCalled();
  });

  /*
    ANDROID OAUTH-AFTER-SCAN (checklist line 97). On Android the OAuth result
    arrives on the DEEP LINK, not the awaited browser session. When the
    guest→account link fails because the Google identity already belongs to an
    existing account, the URL handler must run the same fallback the awaited
    iOS path has: abandon the guest, sign into the account that initiated.
  */
  it('ANDROID DEEP LINK: an identity-already-linked callback falls back to a plain provider sign-in', async () => {
    const guestSession = {
      access_token: 'anon-token',
      user: { id: 'guest-1', is_anonymous: true },
    } as any;
    const accountSession = {
      access_token: 'account-token',
      user: { id: 'owner-1', email: 'owner@example.com' },
    } as any;

    const {
      act,
      authService,
      capturePostHogEvent,
      fireEvent,
      getByTestId,
      getByText,
      getLinkURLHandler,
      waitFor,
    } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => guestSession),
        getNeedsProfile: jest.fn(() => false),
        // Browser takeover: the awaited path resolves null; the result arrives
        // on the deep link below.
        linkOAuthIdentityToCurrentUser: jest.fn(async () => null),
        restoreSessionFromUrl: jest.fn(async () => {
          throw new Error('Identity is already linked to another user');
        }),
        signInWithGoogle: jest.fn(async () => accountSession),
      },
    });

    await waitFor(() => {
      expect(getByText('guest:true')).toBeTruthy();
    });

    fireEvent.press(getByTestId('sign-in-google'));

    await waitFor(() => {
      expect(authService.linkOAuthIdentityToCurrentUser).toHaveBeenCalledWith('google');
    });

    await act(async () => {
      getLinkURLHandler()?.({
        url: 'spotlight://login-callback?error=server_error&error_description=Identity+is+already+linked+to+another+user',
      });
    });

    await waitFor(() => {
      expect(getByText('user:owner-1')).toBeTruthy();
    });
    // The fallback is the PLAIN provider sign-in — the account wins, the guest
    // is abandoned — and lands signed in with no error banner.
    expect(authService.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(authService.bootstrapProfileIfNeeded).toHaveBeenCalledWith(accountSession.user, null, null);
    expect(getByText('state:signedIn')).toBeTruthy();
    expect(getByText('error:none')).toBeTruthy();
    expect(capturePostHogEvent).toHaveBeenCalledWith('auth_sign_in_succeeded', {
      provider: 'google',
    });
  });

  it('ANDROID DEEP LINK: an already-linked error with NO pending link surfaces as an error only', async () => {
    const { authService, getByText, waitFor } = renderAuthProvider({
      initialURL: 'spotlight://login-callback',
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => null),
        restoreSessionFromUrl: jest.fn(async () => {
          throw new Error('Identity is already linked to another user');
        }),
      },
    });

    await waitFor(() => {
      expect(getByText('error:Identity is already linked to another user')).toBeTruthy();
    });
    // No link was initiated from this app run, so no fallback sign-in fires.
    expect(authService.signInWithGoogle).not.toHaveBeenCalled();
    expect(authService.signInWithApple).not.toHaveBeenCalled();
  });

  /*
    AUTH-GATE WHITE SCREEN (checklist line 94). A restored session is trusted
    from local storage, so a server-side revoked/deleted user used to land on a
    signed-in shell whose every request 401s — blank app. The background user
    check must bounce them to login, silently.
  */
  it('REVOKED RESTORED SESSION: a failed server user check lands on signedOut with no error banner', async () => {
    const restoredSession = {
      // Matches the harness getAccessToken mock, so the provider's
      // same-session guard sees this session as still current.
      access_token: 'access-token',
      user: { id: 'gone-1', email: 'gone@example.com' },
    } as any;
    const revokedError = Object.assign(
      new Error('User from sub claim in JWT does not exist'),
      { name: 'AuthApiError' },
    );

    const { authService, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => restoredSession),
        getNeedsProfile: jest.fn(() => false),
        fetchAuthUserError: jest.fn(async () => revokedError),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedOut')).toBeTruthy();
    });
    expect(authService.clearStoredSession).toHaveBeenCalledTimes(1);
    // Silent redirect to login — a revoked session is not the user's mistake.
    expect(getByText('error:none')).toBeTruthy();
  });

  it('OFFLINE RESTORED SESSION: a transport failure on the user check does NOT bounce to login', async () => {
    const restoredSession = {
      access_token: 'access-token',
      user: { id: 'trainer-1', email: 'trainer@example.com' },
    } as any;
    const transportError = Object.assign(
      new Error('Network request failed'),
      { name: 'AuthRetryableFetchError' },
    );

    const { authService, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => restoredSession),
        getNeedsProfile: jest.fn(() => false),
        fetchAuthUserError: jest.fn(async () => transportError),
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });
    await waitFor(() => {
      expect(authService.fetchAuthUserError).toHaveBeenCalledTimes(1);
    });
    // Offline is not revoked: the session survives the blip.
    expect(authService.clearStoredSession).not.toHaveBeenCalled();
    expect(getByText('state:signedIn')).toBeTruthy();
  });

  it('HANDLE CLAIM: submitHandle saves the handle and refreshes the current user', async () => {
    const currentSession = {
      access_token: 'access-token',
      user: { email: 'collector@example.com', id: 'user-1' },
    } as any;
    const baseUser = {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Collector',
      email: 'collector@example.com',
      id: 'user-1',
      labelerEnabled: false,
      providers: ['google'],
      handleKnown: true,
    };
    const resolveAppUserFromSession = jest.fn()
      .mockResolvedValueOnce({ ...baseUser, handle: null })
      .mockResolvedValueOnce({ ...baseUser, handle: 'misty' });

    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => currentSession),
        getNeedsProfile: jest.fn(() => false),
        resolveAppUserFromSession,
      },
    });

    await waitFor(() => {
      expect(getByText('handle:none')).toBeTruthy();
    });

    fireEvent.press(getByTestId('submit-handle'));

    // The re-resolve after the save is what drops the claim gate.
    await waitFor(() => {
      expect(getByText('handle:misty')).toBeTruthy();
    });
    expect(authService.updateProfile).toHaveBeenCalledWith('user-1', { handle: 'misty' });
    expect(getByText('error:none')).toBeTruthy();
  });

  it('HANDLE CLAIM: a taken handle surfaces its message without rethrowing at the screen', async () => {
    const currentSession = {
      access_token: 'access-token',
      user: { email: 'collector@example.com', id: 'user-1' },
    } as any;
    const updateProfile = jest.fn(async () => {
      // Same shape the real ProfileUpdateError('handle-taken') carries.
      throw new Error('That handle is already taken.');
    });

    const { authService, fireEvent, getByTestId, getByText, waitFor } = renderAuthProvider({
      authServiceOverrides: {
        getCurrentSession: jest.fn(async () => currentSession),
        getNeedsProfile: jest.fn(() => false),
        updateProfile,
      },
    });

    await waitFor(() => {
      expect(getByText('state:signedIn')).toBeTruthy();
    });

    fireEvent.press(getByTestId('submit-handle'));

    await waitFor(() => {
      expect(getByText('error:That handle is already taken.')).toBeTruthy();
    });
    // The failed save must not have refreshed the handle.
    expect(getByText('handle:none')).toBeTruthy();
    expect(authService.updateProfile).toHaveBeenCalledWith('user-1', { handle: 'misty' });
  });

  // Owner key = data isolation; remount key = how much of the tree survives a
  // transition. They are deliberately different, and only for guests.
  it('keys the provider tree per account, collapsing ONLY the pending-guest → guest mint', () => {
    const { authModule } = renderAuthProvider();
    const {
      PENDING_GUEST_USER_ID,
      resolveProviderRemountKey,
      resolveSessionOwnerKey,
    } = authModule;

    const pendingGuestOwnerKey = resolveSessionOwnerKey(null, true);
    const guestOwnerKey = resolveSessionOwnerKey('anon-uuid', true);
    const accountAOwnerKey = resolveSessionOwnerKey('user-a', false);
    const accountBOwnerKey = resolveSessionOwnerKey('user-b', false);
    const signedOutOwnerKey = resolveSessionOwnerKey(null, false);

    // Owner keys stay per-uuid — this is what scopes caches and persisted data.
    expect(pendingGuestOwnerKey).toBe(PENDING_GUEST_USER_ID);
    expect(guestOwnerKey).toBe('anon-uuid');
    expect(accountAOwnerKey).toBe('user-a');
    expect(signedOutOwnerKey).toBe('signed-out');

    // The mint must NOT remount (an in-flight scan is riding on it)…
    expect(resolveProviderRemountKey(pendingGuestOwnerKey, true))
      .toBe(resolveProviderRemountKey(guestOwnerKey, true));

    // …but every real account boundary still does.
    expect(resolveProviderRemountKey(accountAOwnerKey, false))
      .not.toBe(resolveProviderRemountKey(accountBOwnerKey, false));
    expect(resolveProviderRemountKey(guestOwnerKey, true))
      .not.toBe(resolveProviderRemountKey(accountAOwnerKey, false));
    expect(resolveProviderRemountKey(accountAOwnerKey, false))
      .not.toBe(resolveProviderRemountKey(signedOutOwnerKey, false));
  });

  it('throws when useAuth is read outside the provider', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv;

    jest.isolateModules(() => {
      const React = require('react') as typeof import('react');
      const testingLibrary = require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native/pure');
      const { useAuth } = require('@/providers/auth-provider') as typeof import('@/providers/auth-provider');

      function Probe() {
        useAuth();
        return null;
      }

      expect(() => testingLibrary.render(React.createElement(Probe))).toThrow(
        'useAuth must be used within AuthProvider.',
      );
    });
  });
});
