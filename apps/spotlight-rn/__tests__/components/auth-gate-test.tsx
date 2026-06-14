import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
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
    signUpEmail: jest.fn().mockResolvedValue({ needsCode: true }),
    signInEmail: jest.fn().mockResolvedValue(undefined),
    verifyCode: jest.fn().mockResolvedValue(undefined),
    resendCode: jest.fn().mockResolvedValue(undefined),
    sendReset: jest.fn().mockResolvedValue(undefined),
    verifyResetCode: jest.fn().mockResolvedValue(undefined),
    updatePassword: jest.fn().mockResolvedValue(undefined),
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

  it('starts the signed-out flow on the Get started screen, then opens the email step', () => {
    const { onGoogleSignIn } = renderAuthGate();

    // Step 0: the branded "Get started" splash.
    expect(screen.getByTestId('auth-get-started-screen')).toBeTruthy();

    // Tapping Get started advances to the email "Login or sign up" step.
    fireEvent.press(screen.getByTestId('auth-get-started-button'));
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();

    // Google is wired straight through to the provider action.
    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(onGoogleSignIn).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText('collector@example.com')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Continue').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
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
