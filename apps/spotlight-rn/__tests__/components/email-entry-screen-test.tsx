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
    expect(screen.getByTestId('auth-email-back')).toBeTruthy();
    expect(screen.getByTestId('auth-brand-wordmark')).toBeTruthy();
    // The tagline must persist past "Continue with Email" (regression: it was
    // suppressed on this step and vanished when leaving the get-started screen).
    expect(screen.getByText('Scan, Price, and Track your collection')).toBeTruthy();
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

  it('calls onBack from the header control', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-email-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('does not render social buttons (they live on the entry screen)', () => {
    renderScreen({ appleSignInAvailable: true });
    expect(screen.queryByTestId('auth-google-button')).toBeNull();
    expect(screen.queryByTestId('auth-apple-button')).toBeNull();
  });

  it('shows the configuration issue and error lines when provided', () => {
    renderScreen({ configurationIssue: 'Auth not configured', errorMessage: 'Network down' });
    expect(screen.getByText('Auth not configured')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });
});
