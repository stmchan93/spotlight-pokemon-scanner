import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { EmailPasswordScreen } from '@/features/auth/components/email-password-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof EmailPasswordScreen>> = {}) {
  const props: React.ComponentProps<typeof EmailPasswordScreen> = {
    email: 'collector@example.com',
    errorMessage: null,
    fullName: '',
    isBusy: false,
    mode: 'signup',
    onBack: jest.fn(),
    onChangeFullName: jest.fn(),
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    onForgotPassword: jest.fn(),
    password: '',
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <EmailPasswordScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('EmailPasswordScreen', () => {
  it('renders signup title, the email field, full-name field and password field', () => {
    renderScreen({ mode: 'signup' });

    expect(screen.getByText('Create your account')).toBeTruthy();
    expect(screen.getByTestId('auth-emailpw-email')).toBeTruthy();
    expect(screen.getByTestId('auth-fullname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-password-input')).toBeTruthy();
    expect(screen.getByText('collector@example.com')).toBeTruthy();
  });

  it('renders the login title and hides the full-name field in login mode', () => {
    renderScreen({ mode: 'login' });

    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.queryByTestId('auth-fullname-input')).toBeNull();
  });

  it('keeps Continue disabled in signup until name + 6-char password are set', () => {
    const props = renderScreen({ mode: 'signup', fullName: '', password: 'secret1' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    const withShortPw = renderScreen({ mode: 'signup', fullName: 'Ada', password: 'short' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(withShortPw.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue in signup when name and a valid password are present', () => {
    const props = renderScreen({ mode: 'signup', fullName: 'Ada', password: 'secret1' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('calls onContinue in login mode once the password is long enough', () => {
    const props = renderScreen({ mode: 'login', password: 'secret1' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards full name and password edits', () => {
    const props = renderScreen({ mode: 'signup' });
    fireEvent.changeText(screen.getByTestId('auth-fullname-input'), 'Ada Lovelace');
    expect(props.onChangeFullName).toHaveBeenCalledWith('Ada Lovelace');
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'hunter2');
    expect(props.onChangePassword).toHaveBeenCalledWith('hunter2');
  });

  it('toggles the password visibility control', () => {
    renderScreen({ mode: 'login', password: 'secret1' });
    const input = screen.getByTestId('auth-password-input');
    expect(input.props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('auth-password-toggle'));
    expect(screen.getByTestId('auth-password-input').props.secureTextEntry).toBe(false);
  });

  it('calls onForgotPassword and onBack from their controls', () => {
    const props = renderScreen({ mode: 'login' });
    fireEvent.press(screen.getByTestId('auth-forgot-password'));
    expect(props.onForgotPassword).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-emailpw-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
