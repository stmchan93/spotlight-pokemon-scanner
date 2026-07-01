import { useCallback, useState } from 'react';

import type { EmailAuthActions } from '@/providers/auth-provider';

import { EmailEntryScreen } from './email-entry-screen';
import { EmailPasswordScreen } from './email-password-screen';
import { ForgotPasswordScreen } from './forgot-password-screen';
import { GetStartedScreen } from './get-started-screen';
import { SetNewPasswordScreen } from './set-new-password-screen';
import { VerifyCodeScreen } from './verify-code-screen';

// The signed-out flow is a self-contained stepper over the email-first Figma
// screens. It owns the email/name/password/code drafts and routes between
// steps; every Supabase call is delegated to `emailAuth` (the auth provider),
// which owns busy/error state and the session transition to signedIn.
//
// Sign Up and Log In are SEPARATE, deliberate paths (no auto-detect): the
// landing offers "Sign Up" and a "Log in" link; each has its own entry screen.
type Step =
  | 'getStarted'
  | 'loginEmail'
  | 'signupEmail'
  | 'signupDetails'
  | 'verify'
  | 'forgot'
  | 'forgotVerify'
  | 'setPassword';

type SignedOutFlowProps = {
  emailAuth: EmailAuthActions;
  appleSignInAvailable: boolean;
  configurationIssue: string | null;
  errorMessage: string | null;
  isBusy: boolean;
  onAppleSignIn: () => void;
  onGoogleSignIn: () => void;
};

export function SignedOutFlow({
  emailAuth,
  appleSignInAvailable,
  configurationIssue,
  errorMessage,
  isBusy,
  onAppleSignIn,
  onGoogleSignIn,
}: SignedOutFlowProps) {
  const [step, setStep] = useState<Step>('getStarted');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  // The auth service / profile stores a single display name; combine first + last.
  const fullName = [firstName, lastName].map((value) => value.trim()).filter(Boolean).join(' ');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Signup-email guard notice ("an account already exists"). Local, not a provider
  // error — it points the user to Log In rather than silently signing them in.
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

  // Enter the two flows from the landing (or via a cross-link). Switching intent
  // carries the typed email but drops any password so one flow's draft can't leak
  // into the other.
  const goToSignup = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('signupEmail');
  }, []);
  const goToLogin = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('loginEmail');
  }, []);

  // LOG IN: sign the existing account in directly. A wrong password / missing
  // account surfaces the provider's errorMessage and keeps the user here — it does
  // NOT auto-route to sign-up (the "Sign up" cross-link is a deliberate choice).
  const handleLogin = useCallback(async () => {
    try {
      await emailAuth.signInEmail({ email, password });
    } catch {
      /* errorMessage already set by the provider */
    }
  }, [email, emailAuth, password]);

  // SIGN UP (email step): guard against an address that already has an account —
  // show a notice pointing to Log In instead of proceeding. New addresses advance
  // to the details step (name + password).
  const handleSignupEmailContinue = useCallback(async () => {
    setSignupNotice(null);
    try {
      const exists = await emailAuth.checkEmail(email);
      if (exists) {
        setSignupNotice('An account with this email already exists.');
        return;
      }
      setPassword('');
      setStep('signupDetails');
    } catch {
      /* errorMessage already set by the provider */
    }
  }, [email, emailAuth]);

  const handleSignUp = useCallback(async () => {
    try {
      const { needsCode } = await emailAuth.signUpEmail({ email, password, fullName });
      // When email confirmation is off the provider already signed us in.
      if (needsCode) {
        setStep('verify');
      }
    } catch {
      /* stay on the details step */
    }
  }, [email, emailAuth, fullName, password]);

  const handleVerifySignup = useCallback(async () => {
    try {
      await emailAuth.verifyCode({ email, code, fullName });
    } catch {
      /* stay on the verify step */
    }
  }, [code, email, emailAuth, fullName]);

  const handleResendSignup = useCallback(() => {
    void emailAuth.resendCode(email).catch(() => {});
  }, [email, emailAuth]);

  const handleSendReset = useCallback(async () => {
    try {
      await emailAuth.sendReset(email);
      setCode('');
      setStep('forgotVerify');
    } catch {
      /* stay on the forgot step */
    }
  }, [email, emailAuth]);

  const handleVerifyReset = useCallback(async () => {
    try {
      await emailAuth.verifyResetCode({ email, code });
      setPassword('');
      setStep('setPassword');
    } catch {
      /* stay on the recovery verify step */
    }
  }, [code, email, emailAuth]);

  const handleUpdatePassword = useCallback(async () => {
    try {
      await emailAuth.updatePassword(password);
    } catch {
      /* stay on the set-password step */
    }
  }, [emailAuth, password]);

  switch (step) {
    case 'loginEmail':
      return (
        <EmailEntryScreen
          configurationIssue={configurationIssue}
          crossLinkLabel="New to Ekalight? Sign up"
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          mode="login"
          onBack={() => setStep('getStarted')}
          onChangeEmail={setEmail}
          onChangePassword={setPassword}
          onContinue={() => void handleLogin()}
          onCrossLink={goToSignup}
          onForgotPassword={() => setStep('forgot')}
          password={password}
        />
      );
    case 'signupEmail':
      return (
        <EmailEntryScreen
          configurationIssue={configurationIssue}
          crossLinkLabel="Already have an account? Log in"
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          mode="signup"
          notice={signupNotice}
          onBack={() => setStep('getStarted')}
          onChangeEmail={setEmail}
          onContinue={() => void handleSignupEmailContinue()}
          onCrossLink={goToLogin}
        />
      );
    case 'signupDetails':
      return (
        <EmailPasswordScreen
          email={email}
          errorMessage={errorMessage}
          firstName={firstName}
          lastName={lastName}
          isBusy={isBusy}
          mode="signup"
          onBack={() => setStep('signupEmail')}
          onChangeFirstName={setFirstName}
          onChangeLastName={setLastName}
          onChangePassword={setPassword}
          onContinue={() => void handleSignUp()}
          onForgotPassword={() => setStep('forgot')}
          password={password}
        />
      );
    case 'verify':
      return (
        <VerifyCodeScreen
          code={code}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('signupDetails')}
          onChangeCode={setCode}
          onContinue={() => void handleVerifySignup()}
          onResend={handleResendSignup}
        />
      );
    case 'forgot':
      return (
        <ForgotPasswordScreen
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('loginEmail')}
          onChangeEmail={setEmail}
          onContinue={() => void handleSendReset()}
        />
      );
    case 'forgotVerify':
      return (
        <VerifyCodeScreen
          code={code}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('forgot')}
          onChangeCode={setCode}
          onContinue={() => void handleVerifyReset()}
          onResend={() => void handleSendReset()}
        />
      );
    case 'setPassword':
      return (
        <SetNewPasswordScreen
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('forgotVerify')}
          onChangePassword={setPassword}
          onContinue={() => void handleUpdatePassword()}
          password={password}
        />
      );
    case 'getStarted':
    default:
      return (
        <GetStartedScreen
          appleSignInAvailable={appleSignInAvailable}
          isBusy={isBusy}
          onApple={onAppleSignIn}
          onGoogle={onGoogleSignIn}
          onLogIn={goToLogin}
          onSignUp={goToSignup}
        />
      );
  }
}
