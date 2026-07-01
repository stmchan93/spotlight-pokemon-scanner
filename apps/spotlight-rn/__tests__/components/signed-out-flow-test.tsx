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

describe('SignedOutFlow — split Sign Up vs Log In', () => {
  it('Log In signs in DIRECTLY and never runs the checkEmail auto-detect', async () => {
    const emailAuth = buildEmailAuth();
    renderFlow(emailAuth);

    // Landing → Log in.
    fireEvent.press(screen.getByTestId('auth-get-started-login'));

    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'me@example.com');
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'secret123');
    fireEvent.press(screen.getByTestId('auth-email-continue'));

    await waitFor(() => {
      expect(emailAuth.signInEmail).toHaveBeenCalledWith({
        email: 'me@example.com',
        password: 'secret123',
      });
    });
    // The old combined flow branched on checkEmail — the split must NOT.
    expect(emailAuth.checkEmail).not.toHaveBeenCalled();
  });

  it('Sign Up with an existing email shows a notice instead of signing in', async () => {
    const emailAuth = buildEmailAuth({ checkEmail: jest.fn(async () => true) });
    renderFlow(emailAuth);

    // Landing → Sign Up.
    fireEvent.press(screen.getByTestId('auth-get-started-signup'));

    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'taken@example.com');
    fireEvent.press(screen.getByTestId('auth-email-continue'));

    await waitFor(() => {
      expect(screen.getByText('An account with this email already exists.')).toBeTruthy();
    });
    // Guarded: it must NOT silently sign in or advance to the details step.
    expect(emailAuth.signInEmail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('auth-firstname-input')).toBeNull();
  });

  it('Sign Up with a new email advances to the name + password step', async () => {
    const emailAuth = buildEmailAuth({ checkEmail: jest.fn(async () => false) });
    renderFlow(emailAuth);

    fireEvent.press(screen.getByTestId('auth-get-started-signup'));
    fireEvent.changeText(screen.getByTestId('auth-email-input'), 'new@example.com');
    fireEvent.press(screen.getByTestId('auth-email-continue'));

    await waitFor(() => {
      expect(screen.getByTestId('auth-firstname-input')).toBeTruthy();
    });
    expect(screen.getByTestId('auth-lastname-input')).toBeTruthy();
  });
});
