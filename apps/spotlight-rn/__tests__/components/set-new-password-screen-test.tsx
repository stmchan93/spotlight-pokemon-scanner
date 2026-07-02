import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SetNewPasswordScreen } from '@/features/auth/components/set-new-password-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof SetNewPasswordScreen>> = {}) {
  const props: React.ComponentProps<typeof SetNewPasswordScreen> = {
    errorMessage: null,
    isBusy: false,
    onBack: jest.fn(),
    onChangePassword: jest.fn(),
    onContinue: jest.fn(),
    password: '',
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <SetNewPasswordScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('SetNewPasswordScreen', () => {
  it('renders the title, password field and update button', () => {
    renderScreen();

    expect(screen.getByText('NEW PASSWORD')).toBeTruthy();
    expect(screen.getByTestId('auth-newpassword-input')).toBeTruthy();
    expect(screen.getByText('Update password')).toBeTruthy();
  });

  it('keeps the button disabled until the password is long enough', () => {
    const props = renderScreen({ password: 'short' });
    fireEvent.press(screen.getByTestId('auth-newpassword-continue'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('calls onContinue with a valid password and toggles visibility', () => {
    // Must satisfy the new password rules: 8+ chars, a number, a special char.
    const props = renderScreen({ password: 'Secret1!' });
    fireEvent.press(screen.getByTestId('auth-newpassword-continue'));
    expect(props.onContinue).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId('auth-newpassword-input').props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('auth-newpassword-toggle'));
    expect(screen.getByTestId('auth-newpassword-input').props.secureTextEntry).toBe(false);
  });

  it('calls onBack from the back button', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByTestId('auth-newpassword-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
