import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { AuthGate } from '@/features/auth/components/auth-gate';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function buildEmailAuth() {
  return {
    checkEmail: jest.fn().mockResolvedValue(false),
    resolveEmailMethod: jest.fn().mockResolvedValue('none'),
    signUpEmail: jest.fn().mockResolvedValue({ needsCode: true }),
    signInEmail: jest.fn().mockResolvedValue(undefined),
    verifyCode: jest.fn().mockResolvedValue(undefined),
    resendCode: jest.fn().mockResolvedValue(undefined),
    sendReset: jest.fn().mockResolvedValue(undefined),
    verifyResetCode: jest.fn().mockResolvedValue(undefined),
    updatePassword: jest.fn().mockResolvedValue(undefined),
    clearError: jest.fn(),
  };
}

function renderAuthGate(overrides: Partial<ComponentProps<typeof AuthGate>> = {}) {
  const onGoogleSignIn = jest.fn();
  const onAppleSignIn = jest.fn();
  const onChangeProfileDraftName = jest.fn();
  const onSubmitProfile = jest.fn();
  const emailAuth = buildEmailAuth();

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <AuthGate
          appleSignInAvailable
          authenticatedContent={null}
          configurationIssue={null}
          currentUser={null}
          emailAuth={emailAuth}
          errorMessage={null}
          isBusy={false}
          isConfigured={true}
          onAppleSignIn={onAppleSignIn}
          onChangeProfileDraftName={onChangeProfileDraftName}
          onGoogleSignIn={onGoogleSignIn}
          onSubmitProfile={onSubmitProfile}
          profileDraftName=""
          state="signedOut"
          {...overrides}
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return {
    emailAuth,
    onAppleSignIn,
    onChangeProfileDraftName,
    onGoogleSignIn,
    onSubmitProfile,
  };
}

describe('AuthGate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts the signed-out flow on the email-first root with social + email auth', () => {
    const { onGoogleSignIn } = renderAuthGate();

    // Email only on the root; the password lives on step 2.
    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    expect(screen.queryByTestId('auth-password-input')).toBeNull();

    // Google is wired straight through to the provider action.
    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(onGoogleSignIn).toHaveBeenCalledTimes(1);
  });

  it('routes a new email to the Sign Up step', async () => {
    renderAuthGate();
    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'new@example.com');
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
    });
    expect(screen.getByTestId('auth-firstname-input')).toBeTruthy();
  });

  it('renders the profile onboarding screen when a display name is required', () => {
    const { onChangeProfileDraftName, onSubmitProfile } = renderAuthGate({
      currentUser: {
        adminEnabled: false,
        avatarURL: null,
        displayName: null,
        email: 'collector@example.com',
        id: 'user-1',
        labelerEnabled: false,
        providers: ['google'],
      },
      profileDraftName: 'Table Steve',
      state: 'needsProfile',
    });

    expect(screen.getByText('Finish your profile')).toBeTruthy();
    expect(screen.getByText('Signed in as collector@example.com')).toBeTruthy();
    // Filled CTA label per the updated Figma (2368:44111 — Body-medium, Medium 14
    // on the token's 18 line box).
    expect(StyleSheet.flatten(screen.getByText('Continue').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodyMedium',
      fontSize: 14,
      lineHeight: 18,
    });

    fireEvent.changeText(screen.getByTestId('auth-profile-input'), 'Stephen');
    expect(onChangeProfileDraftName).toHaveBeenCalledWith('Stephen');

    fireEvent.press(screen.getByTestId('auth-profile-submit'));
    expect(onSubmitProfile).toHaveBeenCalledTimes(1);
  });

  it('renders a blank loading shell while auth is bootstrapping', () => {
    renderAuthGate({
      state: 'loading',
    });

    expect(screen.getByTestId('auth-loading-screen')).toBeTruthy();
    expect(screen.queryByText('Loading Ekalight')).toBeNull();
  });
});
