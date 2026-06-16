import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { GetStartedScreen } from '@/features/auth/components/get-started-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof GetStartedScreen>> = {}) {
  const props: React.ComponentProps<typeof GetStartedScreen> = {
    appleSignInAvailable: true,
    isBusy: false,
    onContinueWithEmail: jest.fn(),
    onGoogle: jest.fn(),
    onApple: jest.fn(),
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <GetStartedScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('GetStartedScreen (pre-login homepage)', () => {
  it('renders the EKALIGHT brand and the three entry actions', () => {
    renderScreen();

    expect(screen.getByTestId('auth-get-started-screen')).toBeTruthy();
    // The flowing wave hero (WebView) mounts behind the content.
    expect(screen.getByTestId('auth-wave-background')).toBeTruthy();
    expect(screen.getByText('EKALIGHT')).toBeTruthy();
    expect(screen.getByText('Scan, Price, and Track your collection')).toBeTruthy();
    expect(screen.getByText('Continue with Email')).toBeTruthy();
    expect(screen.getByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText('Continue with Apple')).toBeTruthy();
  });

  it('always offers Apple below Google on iOS, even if the availability flag is false', () => {
    // App Store guideline 4.8 — Apple Sign In must accompany Google on iOS.
    renderScreen({ appleSignInAvailable: false });
    expect(screen.getByTestId('auth-google-button')).toBeTruthy();
    expect(screen.getByTestId('auth-apple-button')).toBeTruthy();
  });

  it('continues to the email step from the primary button', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-get-started-button'));
    expect(props.onContinueWithEmail).toHaveBeenCalledTimes(1);
  });

  it('invokes the Google and Apple handlers', () => {
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
      // Google still offered on Android.
      expect(screen.getByTestId('auth-google-button')).toBeTruthy();
    } finally {
      Platform.OS = original;
    }
  });
});
