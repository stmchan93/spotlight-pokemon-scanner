import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

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
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    onForgotPassword: jest.fn(),
    onGoogle: jest.fn(),
    onSignUp: jest.fn(),
    password: '',
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

describe('LoginScreen (Figma 2161:6847)', () => {
  it('renders the EKALIGHT header, fields, social actions, and the Sign Up cross-link', () => {
    renderScreen();

    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-header-wordmark')).toBeTruthy();
    expect(screen.getByText('LOG IN')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    expect(screen.getByTestId('auth-password-input')).toBeTruthy();
    expect(screen.getByText('Forgot password?')).toBeTruthy();
    expect(screen.getByText('OR')).toBeTruthy();
    expect(screen.getByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText('Continue with Apple')).toBeTruthy();
    expect(screen.getByText('NEW ACCOUNT')).toBeTruthy();
    expect(screen.getByText('Sign Up')).toBeTruthy();
    // Terms footer per design.
    expect(screen.getByText(/Terms of Use/)).toBeTruthy();
  });

  it('keeps Continue disabled until email is valid AND a password is entered', () => {
    let props = renderScreen({ email: 'not-an-email', password: 'secret123' });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ email: 'collector@example.com', password: '' });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ email: 'collector@example.com', password: 'secret123', isBusy: true });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue with a valid email + password', () => {
    const props = renderScreen({ email: 'collector@example.com', password: 'secret123' });
    fireEvent.press(screen.getByTestId('auth-login-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('routes Forgot password?, Sign Up, and the social buttons', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-forgot-password'));
    expect(props.onForgotPassword).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-login-signup'));
    expect(props.onSignUp).toHaveBeenCalledTimes(1);
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

  it('forwards typing to onChangeEmail and onChangePassword', () => {
    const props = renderScreen();
    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'a@b.com');
    expect(props.onChangeEmail).toHaveBeenCalledWith('a@b.com');
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'hunter2!');
    expect(props.onChangePassword).toHaveBeenCalledWith('hunter2!');
  });

  it('shows the configuration issue and error lines when provided', () => {
    renderScreen({ configurationIssue: 'Auth not configured', errorMessage: 'Network down' });
    expect(screen.getByText('Auth not configured')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });
});
