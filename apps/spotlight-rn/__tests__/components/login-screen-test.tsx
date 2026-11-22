import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { APPLE_SIGN_IN_NOT_SET_UP_MESSAGE } from '@/features/auth/auth-models';
import { LoginScreen } from '@/features/auth/components/login-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof LoginScreen>> = {}) {
  const props: React.ComponentProps<typeof LoginScreen> = {
    appleSignInAvailable: true,
    configurationIssue: null,
    email: '',
    errorMessage: null,
    isBusy: false,
    onApple: jest.fn(),
    onChangeEmail: jest.fn(),
    onContinue: jest.fn(),
    onGoogle: jest.fn(),
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <LoginScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('LoginScreen (email-first root)', () => {
  it('renders the heading, email field, and social actions with no Log In / Sign Up split', () => {
    renderScreen();

    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-header-wordmark')).toBeTruthy();
    expect(screen.getByText('Welcome to Ekalight')).toBeTruthy();
    expect(screen.getByText('Log in or create an account')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    expect(screen.queryByTestId('auth-password-input')).toBeNull();
    expect(screen.queryByText('Sign Up')).toBeNull();
    expect(screen.getByText('OR')).toBeTruthy();
    expect(screen.getByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText('Continue with Apple')).toBeTruthy();
    expect(screen.getByText(/Terms of Use/)).toBeTruthy();
  });

  it('marks the email field as the username for iOS password autofill', () => {
    renderScreen();
    expect(screen.getByTestId('auth-email-input').props.textContentType).toBe('username');
  });

  it('keeps Continue disabled until the email looks valid and the flow is idle', () => {
    let props = renderScreen({ email: 'not-an-email' });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ email: 'collector@example.com', isBusy: true });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ email: 'collector@example.com' });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('routes the social buttons', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(props.onGoogle).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-apple-button'));
    expect(props.onApple).toHaveBeenCalledTimes(1);
  });

  it('hides Apple on Android when Apple sign-in is unavailable', () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    try {
      renderScreen({ appleSignInAvailable: false });
      expect(screen.queryByTestId('auth-apple-button')).toBeNull();
      expect(screen.getByTestId('auth-google-button')).toBeTruthy();
    } finally {
      Platform.OS = original;
    }
  });

  it('shows the configuration issue and error lines when provided', () => {
    renderScreen({ configurationIssue: 'Auth not configured', errorMessage: 'Network down' });
    expect(screen.getByText('Auth not configured')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
    expect(screen.queryByTestId('auth-apple-recovery-google')).toBeNull();
  });

  it('promotes Continue with Google right under the Apple-not-set-up error', () => {
    const props = renderScreen({ errorMessage: APPLE_SIGN_IN_NOT_SET_UP_MESSAGE });
    expect(screen.getByText(APPLE_SIGN_IN_NOT_SET_UP_MESSAGE)).toBeTruthy();
    fireEvent.press(screen.getByTestId('auth-apple-recovery-google'));
    expect(props.onGoogle).toHaveBeenCalledTimes(1);
  });
});
