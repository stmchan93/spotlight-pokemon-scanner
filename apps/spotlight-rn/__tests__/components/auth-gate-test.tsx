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

function renderAuthGate(overrides: Partial<ComponentProps<typeof AuthGate>> = {}) {
  const onGoogleSignIn = jest.fn();
  const onAppleSignIn = jest.fn();
  const onChangeProfileDraftName = jest.fn();
  const onSubmitProfile = jest.fn();

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <AuthGate
          appleSignInAvailable
          authenticatedContent={null}
          configurationIssue={null}
          currentUser={null}
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
    onAppleSignIn,
    onChangeProfileDraftName,
    onGoogleSignIn,
    onSubmitProfile,
  };
}

describe('AuthGate', () => {
  it('renders the sign-in screen when signed out', () => {
    const { onGoogleSignIn } = renderAuthGate({
      configurationIssue: 'Supabase URL is missing.',
      isConfigured: false,
    });

    expect(screen.getByText('Sign into Loooty')).toBeTruthy();
    expect(screen.queryByText('Sync your account before scanner, inventory, and portfolio flows open up.')).toBeNull();
    expect(screen.getByText('Supabase URL is missing.')).toBeTruthy();
    expect(screen.getByTestId('auth-apple-button')).toBeTruthy();
    expect(screen.getByText('Continue with Google')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Continue with Google').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(onGoogleSignIn).not.toHaveBeenCalled();
  });

  it('renders the profile onboarding screen when a display name is required', () => {
    const { onChangeProfileDraftName, onSubmitProfile } = renderAuthGate({
      currentUser: {
        avatarURL: null,
        displayName: null,
        email: 'collector@example.com',
        id: 'user-1',
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
    expect(screen.queryByText('Loading Loooty')).toBeNull();
  });
});
