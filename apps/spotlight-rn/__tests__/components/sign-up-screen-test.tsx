import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SignUpScreen } from '@/features/auth/components/sign-up-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

const validProps = {
  email: 'new@example.com',
  firstName: 'Ash',
  lastName: 'Ketchum',
  password: 'pikachu25!',
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof SignUpScreen>> = {}) {
  const props: React.ComponentProps<typeof SignUpScreen> = {
    appleSignInAvailable: true,
    configurationIssue: null,
    email: '',
    errorMessage: null,
    firstName: '',
    isBusy: false,
    lastName: '',
    notice: null,
    onApple: jest.fn(),
    onBack: jest.fn(),
    onChangeEmail: jest.fn(),
    onChangeFirstName: jest.fn(),
    onChangeLastName: jest.fn(),
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    onGoogle: jest.fn(),
    onLogIn: jest.fn(),
    password: '',
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <SignUpScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('SignUpScreen (Figma 2161:6847)', () => {
  it('renders the full sign-up form with social actions and the LOG IN cross-link', () => {
    renderScreen();

    expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
    expect(screen.getByText('SIGN UP')).toBeTruthy();
    expect(screen.getByTestId('auth-firstname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-lastname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-signup-email-input')).toBeTruthy();
    expect(screen.getByTestId('auth-signup-password-input')).toBeTruthy();
    expect(screen.getByText('OR')).toBeTruthy();
    expect(screen.getByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText('Continue with Apple')).toBeTruthy();
    expect(screen.getByText('LOG IN')).toBeTruthy();
    expect(screen.getByText('Continue with Email')).toBeTruthy();
    expect(screen.getByText(/Terms of Use/)).toBeTruthy();
  });

  it('shows the password checklist once the user starts typing a password', () => {
    renderScreen();
    expect(screen.queryByTestId('auth-signup-password-rules')).toBeNull();

    renderScreen({ password: 'abc' });
    expect(screen.getByTestId('auth-signup-password-rules')).toBeTruthy();
    expect(screen.getByText('Contains 8 characters')).toBeTruthy();
  });

  it('keeps Continue disabled until name, email, and password rules are all satisfied', () => {
    let props = renderScreen({ ...validProps, firstName: '' });
    fireEvent.press(screen.getByTestId('auth-signup-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ ...validProps, email: 'nope' });
    fireEvent.press(screen.getByTestId('auth-signup-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    props = renderScreen({ ...validProps, password: 'short' });
    fireEvent.press(screen.getByTestId('auth-signup-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue when the whole form is valid', () => {
    const props = renderScreen(validProps);
    fireEvent.press(screen.getByTestId('auth-signup-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('surfaces the "account already exists" notice', () => {
    renderScreen({ notice: 'An account with this email already exists.' });
    expect(screen.getByText('An account with this email already exists.')).toBeTruthy();
  });

  it('routes the LOG IN cross-link and social buttons', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-signup-login'));
    expect(props.onLogIn).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(props.onGoogle).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-apple-button'));
    expect(props.onApple).toHaveBeenCalledTimes(1);
  });
});
