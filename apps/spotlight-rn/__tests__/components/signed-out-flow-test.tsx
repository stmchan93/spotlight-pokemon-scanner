import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SignedOutFlow } from '@/features/auth/components/signed-out-flow';
import type { EmailAuthActions } from '@/providers/auth-provider';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function buildEmailAuth(overrides: Partial<EmailAuthActions> = {}): EmailAuthActions {
  return {
    checkEmail: jest.fn(async () => false),
    signUpEmail: jest.fn(async () => ({ needsCode: true })),
    signInEmail: jest.fn(async () => {}),
    verifyCode: jest.fn(async () => {}),
    resendCode: jest.fn(async () => {}),
    sendReset: jest.fn(async () => {}),
    verifyResetCode: jest.fn(async () => {}),
    updatePassword: jest.fn(async () => {}),
    ...overrides,
  };
}

function renderFlow(emailAuth: EmailAuthActions) {
  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <SignedOutFlow
          appleSignInAvailable={false}
          configurationIssue={null}
          emailAuth={emailAuth}
          errorMessage={null}
          isBusy={false}
          onAppleSignIn={jest.fn()}
          onGoogleSignIn={jest.fn()}
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

function fillSignUp() {
  fireEvent.changeText(screen.getByTestId('auth-firstname-input'), 'Ash');
  fireEvent.changeText(screen.getByTestId('auth-lastname-input'), 'Ketchum');
  fireEvent.changeText(screen.getByTestId('auth-signup-password-input'), 'pikachu25!');
}

describe('SignedOutFlow — split Log In vs Sign Up (Figma 2161:6847)', () => {
  it('roots on the Log In screen and signs in DIRECTLY (no checkEmail auto-detect)', async () => {
    const emailAuth = buildEmailAuth();
    renderFlow(emailAuth);

    // Root IS the Log In screen — no landing step in between.
    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'me@example.com');
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'secret123');
    fireEvent.press(screen.getByTestId('auth-login-continue'));

    await waitFor(() => {
      expect(emailAuth.signInEmail).toHaveBeenCalledWith({
        email: 'me@example.com',
        password: 'secret123',
      });
    });
    // The old combined flow branched on checkEmail — the split must NOT.
    expect(emailAuth.checkEmail).not.toHaveBeenCalled();
  });

  it('Sign Up with an existing email shows a notice instead of creating/signing in', async () => {
    const emailAuth = buildEmailAuth({ checkEmail: jest.fn(async () => true) });
    renderFlow(emailAuth);

    fireEvent.press(screen.getByTestId('auth-login-signup'));
    fireEvent.changeText(screen.getByTestId('auth-signup-email-input'), 'taken@example.com');
    fillSignUp();
    fireEvent.press(screen.getByTestId('auth-signup-continue'));

    await waitFor(() => {
      expect(screen.getByText('An account with this email already exists.')).toBeTruthy();
    });
    // Guarded: it must NOT silently sign in or create the account.
    expect(emailAuth.signInEmail).not.toHaveBeenCalled();
    expect(emailAuth.signUpEmail).not.toHaveBeenCalled();
  });

  it('Sign Up with a new email creates the account and advances to code verification', async () => {
    const emailAuth = buildEmailAuth({ checkEmail: jest.fn(async () => false) });
    renderFlow(emailAuth);

    fireEvent.press(screen.getByTestId('auth-login-signup'));
    fireEvent.changeText(screen.getByTestId('auth-signup-email-input'), 'new@example.com');
    fillSignUp();
    fireEvent.press(screen.getByTestId('auth-signup-continue'));

    await waitFor(() => {
      expect(emailAuth.signUpEmail).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'pikachu25!',
        fullName: 'Ash Ketchum',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('auth-verify-code-screen')).toBeTruthy();
    });
  });

  it('Forgot password? opens the PASSWORD RESET screen and sends the code', async () => {
    const emailAuth = buildEmailAuth();
    renderFlow(emailAuth);

    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'me@example.com');
    fireEvent.press(screen.getByTestId('auth-forgot-password'));
    expect(screen.getByTestId('auth-forgot-password-screen')).toBeTruthy();

    // Email carries over from the login screen.
    fireEvent.press(screen.getByTestId('auth-forgot-continue'));
    await waitFor(() => {
      expect(emailAuth.sendReset).toHaveBeenCalledWith('me@example.com');
    });
    await waitFor(() => {
      expect(screen.getByTestId('auth-verify-code-screen')).toBeTruthy();
    });
  });
});
