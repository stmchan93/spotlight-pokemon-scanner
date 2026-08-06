import { useCallback, useEffect, useState } from 'react';

import type { EmailAuthActions } from '@/providers/auth-provider';

import { ForgotPasswordScreen } from './forgot-password-screen';
import { LoginScreen } from './login-screen';
import { SetNewPasswordScreen } from './set-new-password-screen';
import { SignUpScreen } from './sign-up-screen';
import { VerifyCodeScreen } from './verify-code-screen';

// The signed-out flow is a self-contained stepper over the light-theme Figma
// screens (2161:6847 "Log In" / 2170:7283 "Password Reset"). It owns the
// email/name/password/code drafts and routes between steps; every Supabase call
// is delegated to `emailAuth` (the auth provider), which owns busy/error state
// and the session transition to signedIn.
//
// Log In is the root and Sign Up is a SEPARATE, deliberate path (no
// auto-detect): each screen carries a cross-link to the other.
type Step =
  | 'login'
  | 'signup'
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
  /**
   * When present, the Log In root shows a back/close affordance that calls this
   * (e.g. the guest login MODAL dismisses back to the scanner). Omitted for the
   * full-screen signed-out flow, which has no back on the login root.
   */
  onClose?: () => void;
};

export function SignedOutFlow({
  emailAuth,
  appleSignInAvailable,
  configurationIssue,
  errorMessage,
  isBusy,
  onAppleSignIn,
  onGoogleSignIn,
  onClose,
}: SignedOutFlowProps) {
  const [step, setStep] = useState<Step>('login');
  // The auth error is shared across every step. Clear it whenever the step
  // changes so one screen's failure (e.g. a failed password reset) can't follow
  // the user onto the next screen (Log In / Sign Up). `clearError` is stable, so
  // this fires only on a real step change — an error stays visible on the screen
  // where it happened (that step doesn't change).
  const { clearError } = emailAuth;
  useEffect(() => {
    clearError();
  }, [step, clearError]);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  // The auth service / profile stores a single display name; combine first + last.
  const fullName = [firstName, lastName].map((value) => value.trim()).filter(Boolean).join(' ');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Signup guard notice ("an account already exists"). Local, not a provider
  // error — it points the user to Log In rather than silently signing them in.
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

  // Switching intent carries the typed email but drops any password so one
  // flow's draft can't leak into the other.
  const goToSignup = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('signup');
  }, []);
  const goToLogin = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('login');
  }, []);

  // LOG IN: sign the existing account in directly. A wrong password / missing
  // account surfaces the provider's errorMessage and keeps the user here — it
  // does NOT auto-route to sign-up (the Sign Up button is a deliberate choice).
  const handleLogin = useCallback(async () => {
    try {
      await emailAuth.signInEmail({ email, password });
    } catch {
      /* errorMessage already set by the provider */
    }
  }, [email, emailAuth, password]);

  // SIGN UP: guard against an address that already has an account — show a
  // notice pointing to Log In instead of silently signing in — then create the
  // account and advance to code verification when confirmation is on.
  const handleSignUp = useCallback(async () => {
    setSignupNotice(null);
    try {
      const exists = await emailAuth.checkEmail(email);
      if (exists) {
        setSignupNotice('An account with this email already exists.');
        return;
      }
      const { needsCode } = await emailAuth.signUpEmail({ email, password, fullName });
      // When email confirmation is off the provider already signed us in.
      if (needsCode) {
        setStep('verify');
      }
    } catch {
      /* stay on the sign-up step */
    }
  }, [email, emailAuth, fullName, password]);

  const handleVerifySignup = useCallback(async () => {
    try {
      // `password` is only consumed on the guest path (converting an anonymous
      // user sets the password after the code verifies the address); a plain
      // signup already carried it and ignores this.
      await emailAuth.verifyCode({ email, code, fullName, password });
    } catch {
      /* stay on the verify step */
    }
  }, [code, email, emailAuth, fullName, password]);

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
    case 'signup':
      return (
        <SignUpScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          firstName={firstName}
          isBusy={isBusy}
          lastName={lastName}
          notice={signupNotice}
          onApple={onAppleSignIn}
          onBack={goToLogin}
          onChangeEmail={setEmail}
          onChangeFirstName={setFirstName}
          onChangeLastName={setLastName}
          onChangePassword={setPassword}
          onContinue={() => void handleSignUp()}
          onGoogle={onGoogleSignIn}
          onLogIn={goToLogin}
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
          onBack={() => setStep('signup')}
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
          onBack={goToLogin}
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
    case 'login':
    default:
      return (
        <LoginScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onApple={onAppleSignIn}
          onBack={onClose}
          onChangeEmail={setEmail}
          onChangePassword={setPassword}
          onContinue={() => void handleLogin()}
          onForgotPassword={() => setStep('forgot')}
          onGoogle={onGoogleSignIn}
          onSignUp={goToSignup}
          password={password}
        />
      );
  }
}
