import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { VerifyCodeScreen } from '@/features/auth/components/verify-code-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof VerifyCodeScreen>> = {}) {
  const props: React.ComponentProps<typeof VerifyCodeScreen> = {
    code: '',
    email: 'collector@example.com',
    errorMessage: null,
    isBusy: false,
    onBack: jest.fn(),
    onChangeCode: jest.fn(),
    onContinue: jest.fn(),
    onResend: jest.fn(),
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <VerifyCodeScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('VerifyCodeScreen', () => {
  it('renders the title, the email in the subtitle, and the code input', () => {
    renderScreen();

    expect(screen.getByText('Check your inbox')).toBeTruthy();
    expect(
      screen.getByText('Enter the verification code sent to collector@example.com'),
    ).toBeTruthy();
    expect(screen.getByTestId('auth-code-input')).toBeTruthy();
    expect(screen.getByTestId('auth-verify-continue')).toBeTruthy();
  });

  it('keeps Continue disabled until a 6-char code is entered', () => {
    const props = renderScreen({ code: '123' });
    fireEvent.press(screen.getByTestId('auth-verify-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps Continue disabled when busy', () => {
    const props = renderScreen({ code: '123456', isBusy: true });
    fireEvent.press(screen.getByTestId('auth-verify-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue when a 6-char code is entered and not busy', () => {
    const props = renderScreen({ code: '123456' });
    fireEvent.press(screen.getByTestId('auth-verify-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards code edits to onChangeCode', () => {
    const props = renderScreen();
    fireEvent.changeText(screen.getByTestId('auth-code-input'), '999000');
    expect(props.onChangeCode).toHaveBeenCalledWith('999000');
  });

  it('calls onBack from the back control', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-verify-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('disables Resend until the cooldown elapses, then forwards the tap', () => {
    jest.useFakeTimers();
    try {
      const props = renderScreen();

      // The email was just sent by the flow that landed here, so the resend
      // cooldown is seeded on mount — tapping immediately is a no-op (mirrors
      // Supabase's 60s per-address max_frequency, avoiding a surprise 429).
      fireEvent.press(screen.getByTestId('auth-resend'));
      expect(props.onResend).not.toHaveBeenCalled();

      // Once the interval elapses the button re-enables and forwards the tap.
      // The countdown reschedules a 1s timeout on each tick, so advance one
      // second at a time, flushing React state between ticks.
      for (let second = 0; second < 60; second += 1) {
        act(() => {
          jest.advanceTimersByTime(1000);
        });
      }
      fireEvent.press(screen.getByTestId('auth-resend'));
      expect(props.onResend).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
