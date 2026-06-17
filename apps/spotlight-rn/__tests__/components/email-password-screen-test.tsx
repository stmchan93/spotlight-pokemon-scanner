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
    firstName: '',
    lastName: '',
    isBusy: false,
    mode: 'signup',
    onBack: jest.fn(),
    onChangeFirstName: jest.fn(),
    onChangeLastName: jest.fn(),
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
  it('renders the wordmark, email, first/last name and password fields in signup mode', () => {
    renderScreen({ mode: 'signup' });

    expect(screen.getByTestId('auth-brand-wordmark')).toBeTruthy();
    // The value-prop tagline persists through the whole email flow.
    expect(screen.getByText('Scan, Price, and Track your collection')).toBeTruthy();
    expect(screen.getByTestId('auth-emailpw-email')).toBeTruthy();
    expect(screen.getByTestId('auth-firstname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-lastname-input')).toBeTruthy();
    expect(screen.getByTestId('auth-password-input')).toBeTruthy();
    expect(screen.getByText('collector@example.com')).toBeTruthy();
  });

  it('hides the name fields in login mode', () => {
    renderScreen({ mode: 'login' });

    expect(screen.getByTestId('auth-brand-wordmark')).toBeTruthy();
    expect(screen.queryByTestId('auth-firstname-input')).toBeNull();
    expect(screen.queryByTestId('auth-lastname-input')).toBeNull();
  });

  it('keeps Continue disabled in signup until both first and last name are set', () => {
    // Only a first name → still disabled (last name required too).
    const props = renderScreen({ mode: 'signup', firstName: 'Ada', lastName: '', password: 'Secret1!' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps Continue disabled in signup when the password fails the rules', () => {
    // "secret1" has 7 chars and no special character — fails the signup rules.
    const props = renderScreen({ mode: 'signup', firstName: 'Ada', lastName: 'Lovelace', password: 'secret1' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue in signup when both names and a rule-passing password are present', () => {
    const props = renderScreen({ mode: 'signup', firstName: 'Ada', lastName: 'Lovelace', password: 'Secret1!' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('calls onContinue in login mode once the password is entered', () => {
    const props = renderScreen({ mode: 'login', password: 'secret1' });
    fireEvent.press(screen.getByTestId('auth-emailpw-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards first name, last name and password edits', () => {
    const props = renderScreen({ mode: 'signup' });
    fireEvent.changeText(screen.getByTestId('auth-firstname-input'), 'Ada');
    expect(props.onChangeFirstName).toHaveBeenCalledWith('Ada');
    fireEvent.changeText(screen.getByTestId('auth-lastname-input'), 'Lovelace');
    expect(props.onChangeLastName).toHaveBeenCalledWith('Lovelace');
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
