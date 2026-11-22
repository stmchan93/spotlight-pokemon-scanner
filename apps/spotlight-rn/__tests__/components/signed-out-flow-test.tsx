import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { SignedOutFlow } from '@/features/auth/components/signed-out-flow';
import type { EmailAuthActions, EmailAuthMethod } from '@/providers/auth-provider';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function buildEmailAuth(overrides: Partial<EmailAuthActions> = {}): EmailAuthActions {
  return {
    checkEmail: jest.fn(async () => false),
    resolveEmailMethod: jest.fn(async (): Promise<EmailAuthMethod | null> => 'password'),
    signUpEmail: jest.fn(async () => ({ needsCode: true })),
    signInEmail: jest.fn(async () => {}),
    verifyCode: jest.fn(async () => {}),
    resendCode: jest.fn(async () => {}),
    sendReset: jest.fn(async () => {}),
    verifyResetCode: jest.fn(async () => {}),
    updatePassword: jest.fn(async () => {}),
    clearError: jest.fn(),
    ...overrides,
  };
}

function renderFlow(emailAuth: EmailAuthActions, handlers: { onApple?: jest.Mock; onGoogle?: jest.Mock } = {}) {
  const onAppleSignIn = handlers.onApple ?? jest.fn();
  const onGoogleSignIn = handlers.onGoogle ?? jest.fn();
  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <SignedOutFlow
          appleSignInAvailable={false}
          configurationIssue={null}
          emailAuth={emailAuth}
          errorMessage={null}
          isBusy={false}
          onAppleSignIn={onAppleSignIn}
          onGoogleSignIn={onGoogleSignIn}
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
  return { onAppleSignIn, onGoogleSignIn };
}

function methodAuth(method: EmailAuthMethod | null, overrides: Partial<EmailAuthActions> = {}) {
  return buildEmailAuth({ resolveEmailMethod: jest.fn(async () => method), ...overrides });
}

async function continueWithEmail(email: string) {
  fireEvent.changeText(screen.getByTestId('auth-email-input'), email);
  fireEvent.press(screen.getByTestId('auth-login-continue'));
}

function fillSignUp() {
  fireEvent.changeText(screen.getByTestId('auth-firstname-input'), 'Ash');
  fireEvent.changeText(screen.getByTestId('auth-lastname-input'), 'Ketchum');
  fireEvent.changeText(screen.getByTestId('auth-signup-password-input'), 'pikachu25!');
}

describe('SignedOutFlow — email-first routing', () => {
  it('roots on the email step and looks up the trimmed address on Continue', async () => {
    const emailAuth = methodAuth('password');
    renderFlow(emailAuth);

    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();
    await continueWithEmail('  me@example.com ');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    expect(emailAuth.resolveEmailMethod).toHaveBeenCalledWith('me@example.com');
  });

  it("'password' → Welcome back password step that signs in", async () => {
    const emailAuth = methodAuth('password');
    renderFlow(emailAuth);
    await continueWithEmail('me@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
    // A known password account gets no create-account escape.
    expect(screen.queryByTestId('auth-password-create-account')).toBeNull();

    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'secret123');
    fireEvent.press(screen.getByTestId('auth-password-continue'));
    await waitFor(() => {
      expect(emailAuth.signInEmail).toHaveBeenCalledWith({
        email: 'me@example.com',
        password: 'secret123',
      });
    });
    expect(emailAuth.checkEmail).not.toHaveBeenCalled();
  });

  it('RPC failure (null) → password step, with a create-account escape', async () => {
    const emailAuth = methodAuth(null);
    renderFlow(emailAuth);
    await continueWithEmail('me@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('auth-password-create-account'));
    expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
  });

  it.each([
    ['google', 'This account signs in with Google.', true, false],
    ['apple', 'This account signs in with Apple.', false, true],
    ['oauth', 'This account signs in with Google or Apple.', true, true],
  ] as const)("'%s' → social account step", async (method, copy, hasGoogle, hasApple) => {
    const emailAuth = methodAuth(method);
    const { onAppleSignIn, onGoogleSignIn } = renderFlow(emailAuth);
    await continueWithEmail('me@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-social-account-screen')).toBeTruthy();
    });
    expect(screen.getByText('Welcome back')).toBeTruthy();
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByTestId('auth-password-input')).toBeNull();
    expect(Boolean(screen.queryByTestId('auth-google-button'))).toBe(hasGoogle);
    expect(Boolean(screen.queryByTestId('auth-apple-button'))).toBe(hasApple);

    if (hasGoogle) {
      fireEvent.press(screen.getByTestId('auth-google-button'));
      expect(onGoogleSignIn).toHaveBeenCalledTimes(1);
    }
    if (hasApple) {
      fireEvent.press(screen.getByTestId('auth-apple-button'));
      expect(onAppleSignIn).toHaveBeenCalledTimes(1);
    }

    // "Not you?" returns to step 1 with the email still filled in.
    fireEvent.press(screen.getByTestId('auth-social-use-another-email'));
    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input').props.value).toBe('me@example.com');
  });

  it("'none' → create account, skipping the existence guard, then code verification", async () => {
    const emailAuth = methodAuth('none');
    renderFlow(emailAuth);
    await continueWithEmail('new@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
    });
    expect(screen.getByText('Create your account')).toBeTruthy();
    expect(screen.getByText('new@example.com')).toBeTruthy();

    fillSignUp();
    fireEvent.press(screen.getByTestId('auth-signup-continue'));

    await waitFor(() => {
      expect(emailAuth.signUpEmail).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'pikachu25!',
        fullName: 'Ash Ketchum',
      });
    });
    expect(emailAuth.checkEmail).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('auth-verify-code-screen')).toBeTruthy();
    });
  });

  // The guest conversion sets the password only AFTER the emailed code proves
  // the address, so the code step has to carry the draft password back.
  it('carries the signup password into code verification (guest conversion needs it)', async () => {
    const emailAuth = methodAuth('none');
    renderFlow(emailAuth);
    await continueWithEmail('new@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-signup-screen')).toBeTruthy();
    });
    fillSignUp();
    fireEvent.press(screen.getByTestId('auth-signup-continue'));

    await waitFor(() => {
      expect(screen.getByTestId('auth-verify-code-screen')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('auth-code-input'), '123456');
    fireEvent.press(screen.getByTestId('auth-verify-continue'));

    await waitFor(() => {
      expect(emailAuth.verifyCode).toHaveBeenCalledWith({
        code: '123456',
        email: 'new@example.com',
        fullName: 'Ash Ketchum',
        password: 'pikachu25!',
      });
    });
  });

  it('Sign Up reached via the RPC fallback keeps the existing-account guard', async () => {
    const emailAuth = methodAuth(null, { checkEmail: jest.fn(async () => true) });
    renderFlow(emailAuth);
    await continueWithEmail('taken@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('auth-password-create-account'));
    fillSignUp();
    fireEvent.press(screen.getByTestId('auth-signup-continue'));

    await waitFor(() => {
      expect(screen.getByText('An account with this email already exists.')).toBeTruthy();
    });
    expect(emailAuth.signUpEmail).not.toHaveBeenCalled();
  });

  it('the email chip goes back to step 1 and drops the password draft', async () => {
    const emailAuth = methodAuth('password');
    renderFlow(emailAuth);
    await continueWithEmail('me@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    fireEvent.changeText(screen.getByTestId('auth-password-input'), 'secret123');
    fireEvent.press(screen.getByTestId('auth-email-chip'));
    expect(screen.getByTestId('auth-login-screen')).toBeTruthy();

    fireEvent.press(screen.getByTestId('auth-login-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    expect(screen.getByTestId('auth-password-input').props.value).toBe('');
  });

  it('Forgot password? opens the PASSWORD RESET screen and sends the code', async () => {
    const emailAuth = methodAuth('password');
    renderFlow(emailAuth);
    await continueWithEmail('me@example.com');

    await waitFor(() => {
      expect(screen.getByTestId('auth-password-screen')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('auth-forgot-password'));
    expect(screen.getByTestId('auth-forgot-password-screen')).toBeTruthy();

    fireEvent.press(screen.getByTestId('auth-forgot-continue'));
    await waitFor(() => {
      expect(emailAuth.sendReset).toHaveBeenCalledWith('me@example.com');
    });
    await waitFor(() => {
      expect(screen.getByTestId('auth-verify-code-screen')).toBeTruthy();
    });
  });
});
