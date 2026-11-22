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
    email: 'new@example.com',
    errorMessage: null,
    firstName: '',
    isBusy: false,
    lastName: '',
    notice: null,
    onApple: jest.fn(),
    onBack: jest.fn(),
    onChangeFirstName: jest.fn(),
    onChangeLastName: jest.fn(),
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    onGoogle: jest.fn(),
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

describe('SignUpScreen (email-first step 2, new address)', () => {
  it('renders the create-account form with the typed email as a back chip', () => {
    renderScreen();

    expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
    expect(screen.getByText('Create your account')).toBeTruthy();
    expect(screen.getByTestId('auth-email-chip')).toBeTruthy();
    expect(screen.getByText('new@example.com')).toBeTruthy();
    expect(screen.getByTestId('auth-firstname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-lastname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-signup-password-input')).toBeTruthy();
    expect(screen.getByTestId('auth-signup-password-input').props.textContentType).toBe('newPassword');
    expect(screen.getByText(/Signed up with Apple before\?/)).toBeTruthy();
    expect(screen.getByText(/Terms of Use/)).toBeTruthy();
  });

  it('shows the password checklist once the user starts typing a password', () => {
    renderScreen();
    expect(screen.queryByTestId('auth-signup-password-rules')).toBeNull();

    renderScreen({ password: 'abc' });
    expect(screen.getByTestId('auth-signup-password-rules')).toBeTruthy();
    expect(screen.getByText('Contains 8 characters')).toBeTruthy();
  });

  it('keeps Continue disabled until name and password rules are satisfied', () => {
    let props = renderScreen({ ...validProps, firstName: '' });
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

  it('routes the email chip back and the Apple Hide-My-Email link to Apple', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-email-chip'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-signup-apple-link'));
    expect(props.onApple).toHaveBeenCalledTimes(1);
  });
});
