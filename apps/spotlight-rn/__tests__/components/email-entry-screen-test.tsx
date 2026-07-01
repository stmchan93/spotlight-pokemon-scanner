import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { EmailEntryScreen } from '@/features/auth/components/email-entry-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof EmailEntryScreen>> = {}) {
  const props: React.ComponentProps<typeof EmailEntryScreen> = {
    mode: 'login',
    configurationIssue: null,
    email: '',
    errorMessage: null,
    isBusy: false,
    onBack: jest.fn(),
    onChangeEmail: jest.fn(),
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    onForgotPassword: jest.fn(),
    password: '',
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <EmailEntryScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('EmailEntryScreen — login mode', () => {
  it('renders the key testIDs (email + password + forgot)', () => {
    renderScreen();

    expect(screen.getByTestId('auth-email-entry-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    // Log in shows email + password together on one screen.
    expect(screen.getByTestId('auth-password-input')).toBeTruthy();
    expect(screen.getByTestId('auth-forgot-password')).toBeTruthy();
    expect(screen.getByTestId('auth-email-continue')).toBeTruthy();
    expect(screen.getByTestId('auth-email-back')).toBeTruthy();
    expect(screen.getByTestId('auth-brand-wordmark')).toBeTruthy();
    // The tagline must persist past the landing screen (regression guard).
    expect(screen.getByText('Scan, Price, and Track your collection')).toBeTruthy();
    // Primary CTA reads "Log in" in this mode.
    expect(screen.getByText('Log in')).toBeTruthy();
  });

  it('disables Continue until the email looks valid', () => {
    const props = renderScreen({ email: 'not-an-email', password: 'secret123' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps Continue disabled when busy even with a valid email + password', () => {
    const props = renderScreen({ email: 'collector@example.com', password: 'secret123', isBusy: true });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps Continue disabled with a valid email but no password', () => {
    const props = renderScreen({ email: 'collector@example.com', password: '' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue when pressed with a valid email AND password, not busy', () => {
    const props = renderScreen({ email: 'collector@example.com', password: 'secret123' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards typing to onChangeEmail and onChangePassword', () => {
    const props = renderScreen();
    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'a@b.com');
    expect(props.onChangeEmail).toHaveBeenCalledWith('a@b.com');
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'hunter2!');
    expect(props.onChangePassword).toHaveBeenCalledWith('hunter2!');
  });

  it('invokes onForgotPassword from the reset link', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-forgot-password'));
    expect(props.onForgotPassword).toHaveBeenCalledTimes(1);
  });

  it('calls onBack from the header control', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-email-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('does not render social buttons (they live on the landing screen)', () => {
    renderScreen();
    expect(screen.queryByTestId('auth-google-button')).toBeNull();
    expect(screen.queryByTestId('auth-apple-button')).toBeNull();
  });

  it('shows the configuration issue and error lines when provided', () => {
    renderScreen({ configurationIssue: 'Auth not configured', errorMessage: 'Network down' });
    expect(screen.getByText('Auth not configured')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });

  it('renders the cross-link and fires onCrossLink', () => {
    const onCrossLink = jest.fn();
    renderScreen({ onCrossLink, crossLinkLabel: 'New to Ekalight? Sign up' });
    fireEvent.press(screen.getByTestId('auth-email-cross-link'));
    expect(onCrossLink).toHaveBeenCalledTimes(1);
  });
});

describe('EmailEntryScreen — signup mode', () => {
  it('shows only the email field (no password, no forgot link) with a Continue CTA', () => {
    renderScreen({ mode: 'signup' });
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    expect(screen.queryByTestId('auth-password-input')).toBeNull();
    expect(screen.queryByTestId('auth-forgot-password')).toBeNull();
    expect(screen.getByText('Continue')).toBeTruthy();
  });

  it('enables Continue on a valid email alone (no password required)', () => {
    const props = renderScreen({ mode: 'signup', email: 'new@example.com' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('surfaces the "account already exists" notice', () => {
    renderScreen({ mode: 'signup', notice: 'An account with this email already exists.' });
    expect(screen.getByText('An account with this email already exists.')).toBeTruthy();
  });
});
