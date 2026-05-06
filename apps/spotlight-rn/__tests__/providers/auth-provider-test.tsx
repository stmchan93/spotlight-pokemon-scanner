describe('AuthProvider', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.clearAllMocks();
    jest.resetModules();
    jest.unmock('expo-linking');
    jest.unmock('@/features/auth/auth-service');
    jest.unmock('@/lib/observability/posthog');
    jest.unmock('@/lib/supabase');
  });

  function renderAuthProvider({
    nodeEnv = 'development',
    authServiceOverrides,
    initialURL = null,
  }: {
    nodeEnv?: string;
    authServiceOverrides?: Record<string, unknown>;
    initialURL?: string | null;
  } = {}) {
    process.env = {
      ...originalEnv,
      NODE_ENV: nodeEnv,
    } as NodeJS.ProcessEnv;

    const capturePostHogEvent = jest.fn();
    const linkRemove = jest.fn();
    const authUnsubscribe = jest.fn();
    let authStateChangeHandler:
      | ((event: string, session: any) => void)
      | null = null;

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
      isAuthCanceledError: jest.fn((error) => error instanceof MockAuthCanceledError),
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
      upsertProfile: jest.fn(async () => {}),
      ...authServiceOverrides,
    };

    jest.doMock('expo-linking', () => ({
      addEventListener: jest.fn((_event, callback) => ({
        callback,
        remove: linkRemove.mockImplementation(() => undefined),
      })),
      getInitialURL: jest.fn(async () => initialURL),
    }));
    jest.doMock('@/features/auth/auth-service', () => authService);
    jest.doMock('@/lib/observability/posthog', () => ({
      capturePostHogEvent,
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
          React.createElement(Text, { testID: 'profile' }, `profile:${auth.profileDraftName || '<empty>'}`),
          React.createElement(Text, { testID: 'error' }, `error:${auth.errorMessage ?? 'none'}`),
          React.createElement(Text, { testID: 'apple' }, `apple:${String(auth.appleSignInAvailable)}`),
          React.createElement(Text, { testID: 'configured' }, `configured:${String(auth.isConfigured)}`),
          React.createElement(Text, { testID: 'config-issue' }, `config:${auth.configurationIssue ?? 'none'}`),
          React.createElement(Text, { testID: 'token' }, `token:${auth.accessToken ?? 'none'}`),
          React.createElement(Pressable, { testID: 'sign-in-apple', onPress: () => { void auth.signInWithApple(); } }),
          React.createElement(Pressable, { testID: 'sign-in-google', onPress: () => { void auth.signInWithGoogle(); } }),
          React.createElement(Pressable, { testID: 'sign-out', onPress: () => { void auth.signOut(); } }),
          React.createElement(Pressable, { testID: 'set-empty-name', onPress: () => auth.setProfileDraftName('   ') }),
          React.createElement(Pressable, { testID: 'set-profile-name', onPress: () => auth.setProfileDraftName('  Misty  ') }),
          React.createElement(Pressable, { testID: 'submit-profile', onPress: () => { void auth.submitProfile(); } }),
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
      linkRemove,
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
