import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { ForgotPasswordScreen } from '@/features/auth/components/forgot-password-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof ForgotPasswordScreen>> = {}) {
  const props: React.ComponentProps<typeof ForgotPasswordScreen> = {
    email: '',
    errorMessage: null,
    isBusy: false,
    onBack: jest.fn(),
    onChangeEmail: jest.fn(),
    onContinue: jest.fn(),
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <ForgotPasswordScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('ForgotPasswordScreen', () => {
  it('renders the title, prefilled email input and the send button', () => {
    renderScreen({ email: 'collector@example.com' });

    expect(screen.getByText('Forgot your password?')).toBeTruthy();
    expect(screen.getByTestId('auth-forgot-email-input').props.value).toBe('collector@example.com');
    expect(screen.getByText('Send reset code')).toBeTruthy();
  });

  it('keeps the button disabled until the email looks valid', () => {
    const props = renderScreen({ email: 'nope' });
    fireEvent.press(screen.getByTestId('auth-forgot-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue with a valid email and onBack from the back button', () => {
    const props = renderScreen({ email: 'collector@example.com' });
    fireEvent.press(screen.getByTestId('auth-forgot-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('auth-forgot-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
