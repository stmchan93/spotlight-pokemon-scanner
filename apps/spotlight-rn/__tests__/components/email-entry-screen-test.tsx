import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { EmailEntryScreen } from '@/features/auth/components/email-entry-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof EmailEntryScreen>> = {}) {
  const props: React.ComponentProps<typeof EmailEntryScreen> = {
    appleSignInAvailable: false,
    configurationIssue: null,
    email: '',
    errorMessage: null,
    isBusy: false,
    onApple: jest.fn(),
    onBack: jest.fn(),
    onChangeEmail: jest.fn(),
    onContinue: jest.fn(),
    onGoogle: jest.fn(),
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

describe('EmailEntryScreen', () => {
  it('renders the key testIDs', () => {
    renderScreen();

    expect(screen.getByTestId('auth-email-entry-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
    expect(screen.getByTestId('auth-email-continue')).toBeTruthy();
    expect(screen.getByTestId('auth-google-button')).toBeTruthy();
    expect(screen.getByTestId('auth-email-back')).toBeTruthy();
    expect(screen.getByText('Login or sign up')).toBeTruthy();
  });

  it('disables Continue until the email looks valid, then calls onContinue', () => {
    const props = renderScreen({ email: 'not-an-email' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();

    renderScreen({ email: 'collector@example.com' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps Continue disabled when busy even with a valid email', () => {
    const props = renderScreen({ email: 'collector@example.com', isBusy: true });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue when pressed with a valid email and not busy', () => {
    const props = renderScreen({ email: 'collector@example.com' });
    fireEvent.press(screen.getByTestId('auth-email-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards typing to onChangeEmail', () => {
    const props = renderScreen();
    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'a@b.com');
    expect(props.onChangeEmail).toHaveBeenCalledWith('a@b.com');
  });

  it('calls onGoogle and onBack from their controls', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-google-button'));
    expect(props.onGoogle).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-email-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('renders the Apple button on iOS when appleSignInAvailable', () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      const props = renderScreen({ appleSignInAvailable: true });
      const appleButton = screen.getByTestId('auth-apple-button');
      expect(appleButton).toBeTruthy();
      fireEvent.press(appleButton);
      expect(props.onApple).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = original;
    }
  });

  it('hides the Apple button when appleSignInAvailable is false', () => {
    renderScreen({ appleSignInAvailable: false });
    expect(screen.queryByTestId('auth-apple-button')).toBeNull();
  });

  it('shows the configuration issue and error lines when provided', () => {
    renderScreen({ configurationIssue: 'Auth not configured', errorMessage: 'Network down' });
    expect(screen.getByText('Auth not configured')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });
});
